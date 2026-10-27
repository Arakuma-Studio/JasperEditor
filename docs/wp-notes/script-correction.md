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
  - or capitalised in more mid-sentence occurrences than it is written in lower case;
  - or capitalised mid-sentence in at least a third of its occurrences (names the script writes both ways, such as
    "Nova" twice and "nova" four times; added after the SC-105 harness, see "Accuracy on real recordings").
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
  - Packing consecutive stretches into windows of ≤ 28 s (spec addition) is an option, off by default since the
    SC-105 harness (see "Accuracy on real recordings").
  - A stretch with more than 100 words is split at its largest gap too (`maxWords`; only loops reach it).
  - Every window satisfies the SC-092 request limits (`SCORE_REQUEST_LIMITS`): reading ids are `r1`, `r2`… (regions
    map them to candidates), a window with more than 63 candidates is repeated over the same audio, words the scorer
    cannot read (empty or over 128 characters) are in no window, and a window over 30 s is never built. Candidates that
    lose their window this way are `unplaced` (`unreadable`, `tooLong`).
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
  - Clamping keeps every word at least 1 flick long while the span leaves 1 flick for each word still to come.
  - Confidence = the word's forced `probability` (SC-041).
  - **`del` into a gap under 60 ms (`DEL_MIN_GAP_SECONDS`)** — the one exception to SC-041's "words outside the
    fixed region keep their times exactly":
    - The edit takes in the following word (`candidate.anchor`, side `after`); its exact text goes in `expect`.
    - The inserted words and that word take reading k's forced times, clamped within [previous word's end,
      following word's end].
    - With no following word, the previous word is taken in the same way (side `before`): clamped within [its start,
      its end + 0.35 s].
    - The taken-in word keeps its text and confidence.
    - A zero-length neighbour is never taken in, because a span cannot name it; such a `del` stays in the gap.
    - With a gap ≥ 60 ms the inserted words go inside the gap and both neighbours keep their times.
  - No-audio fixes spread the words over the region's span by character count (`spreadTokens`, SC-042), with no
    confidence.
  - `replaceWordsEdit` returns `{start, end, expect, words}`: the span the words lie in, the exact old texts
    (`[]` for `del`; the taken-in word for a widened `del`) and the new words.

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
| | length | ≤ 28 s and ≤ 100 words, not packed |
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
  - windows → fake scores → Δ_tok → edit, and malformed results;
  - `del` edits for a < 60 ms gap (following word taken in), a ≥ 60 ms gap (inside the gap) and the end of the
    transcript (previous word taken in).
- **`test/script-fix-property.test.ts`** (SC-100, fast-check):
  - parser and aligner never throw and are deterministic;
  - every transcript token is covered once, in order;
  - E_LIMIT is returned at the bounds;
  - the aligner equals the dense port;
  - candidates sit between exact anchors, are never `ins` and contain no digits;
  - for `del` / `sub` edits with arbitrary forced times and gaps of 0–0.9 s: `expect` equals the words overlapping the
    span, the edited transcript stays sorted and non-overlapping, and every new word lies inside the span and lasts
    ≥ 1 flick when the span allows it;
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
- Result: aligned 85.6 %, off-script 9.1 %, 214 retake jumps, 740,887 merge cells, 791 candidates, 307 windows
  (measured with window packing, the default then; windows are unpacked by default since the SC-105 harness).
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
  - Re-measured with the editor's ONNX fp32 scorer on the same items by the SC-105 harness ("Accuracy on real
    recordings"): the margins stay; still in-sample.
- **Score result times.** The SC-092 result word times are assumed to be absolute media flicks, like the request
  windows. If the scorer returns window-relative times, the engine must add the window start before calling
  `decideFix`.
- **Assumptions (not measured):**
  - the English loanword list and spelling hints;
  - proper-noun detection, i.e. mid-sentence capitals and brand-like spellings, beyond the 16 harness items. The
    spike used a hand-pruned list of the user's own names, which can't ship.
- **Numbers.** Number words without digits ("dos" vs "tos") are not treated as numbers. That rule is the spike's
  digit test.
- **Glossary and the number rule.** The number rule also applies to glossary entries: an entry with digits is never
  offered.
- **`del` next to a zero-length word.** When the gap is under 60 ms and the following word is zero-length (or there
  is no following word and the previous word is zero-length), nothing is taken in. The inserted words then share
  the gap and can be shorter than 1 flick each when the gap is narrower than the number of words.
- **Glued words.** Splits and glued words that are not exact concatenations are still missed at alignment
  (F§4.3: 2 of 96).
- **Homophones.** Undecidable by audio; the script wins ties (F§5.2).
- **Retakes.** Every take gets its own candidates; repeated takes share the fingerprint, so rejecting one rejects
  all.

## Applying fixes (replaceWords, subtitle patch, proposal)

Package `scapply` (branch `feat/sc-scapply`): SC-050…SC-055 and SC-060…SC-062 plus the proposal item builder. The
aligner, speech scoring, the job / route / MCP `fix_transcript` and the Fix UI are other packages.

### `transcript.replaceWords` (SC-050)

`{transcriptId, edits: [{start, end, expect, words: [{text, start, end, confidence}]}], subtitles?: 'patch' | 'none',
captionTracks?: 'patch' | 'none'}` (`packages/project/src/commands/schemas/script-fix.ts`, handler
`commands/handlers/script-fix.ts`, plan `captions/replace-words.ts`). Times are media-time flicks.

- **Index-free.** An edit names the span `[start, end)` of the old words and their exact texts. A transcript word is in
  the span when it overlaps it (a zero-length word when it starts inside it; for an empty span `[p, p)`, a word that
  straddles p). For an insertion (`del` candidates) the span is the gap between the neighbours (previous word's end →
  next word's start) and `expect` is `[]`. Because nothing refers to word indices, many edits — and many
  `replaceWords` commands of one transaction (an accepted proposal) — compose; each command sees the earlier ones'
  result.
- **Refusals.** `E_NOT_FOUND` (transcript); `E_STALE` (new code in `commands/types.ts` `ERROR_CODES`, MCP hint in
  `TX_ERROR_HINTS`; the agent schema lists it automatically): the words in a span are not `expect` any more — the
  message names what they are now; `E_INVALID_PARAM`: no edits, an edit replacing nothing with nothing, edits unsorted
  or overlapping, a word lying in two spans, new words unsorted / overlapping / outside `[start, end]`, more than 64
  old or new words per edit, more than 20 000 edits; `E_SCHEMA`: a word with spaces, unknown keys, bad types.
- **What changes.** Only the replaced words (untouched words keep their objects and times; transcript `segments` stay).
  The first new word keeps the first replaced word's `breakBefore` (a deleted line / segment start passes its break
  to the next word); with as many new as old words each keeps its own break and speaker, otherwise all take the
  first old word's speaker (an insertion takes its neighbour's). `confidence` = the producer's value (the verified
  probability, SC-041 / SC-054; null when unknown). INV-012 holds (the result is checked with `wordsWellFormed`
  before anything is written). Undo / redo: one History entry with the transcript, subtitle and caption changes
  (snapshot history, tested in `packages/session/test/script-fix.test.ts`).
- `sequenceWords(doc, seq, only?)` gained an optional `{transcriptId, from, to}` restriction (same mapping and
  top-track claims) so the patch maps exactly the replaced words without building the whole sequence transcript.

### Subtitle and caption-track patch (SC-051 / SC-052)

Runs inside the same command when the transcript is the current one of its media (`transcriptForMedia`).

1. Per sequence playing the media, the old words and the new words are mapped through the audio clips exactly as the
   sequence transcript maps them (top audio track first, a word belongs to the clip holding its midpoint): one
   *occurrence* per edit and audio clip.
2. **Subtitle groups** (spec 13 text clips): a group takes the occurrence when its `sourceRef` hears that clip
   (`sequence-transcript`; `media` of that media; `clips` naming the audio clip or a clip linked to it). A subtitle
   word matches an old word when the midpoint of one lies inside the other and the normalised texts (`normalizeWord`)
   are equal — the old word as the group's text transforms show it (`transformWords` with the word before as context,
   so Sentence case and the profanity mask are reproduced), or as it is. The matched subtitle words must be a
   contiguous run in order; otherwise the clip is **skipped `edited`** (hand-edited). An insertion goes into the
   subtitle whose range holds the first new word's midpoint, after the words before it.
3. Old words spread over several subtitles: the new words go to the subtitle holding each one's midpoint (nearest
   otherwise); a subtitle that would be left without any word makes all of them **skipped `split`**.
4. **Splice** (`captions/subtitles/patch.ts` `spliceContent`): the display text of the new words (the group's
   transforms; trailing punctuation stripped when the group strips it and the run ends the subtitle) replaces the
   located region of the clip text (`locateWords`). Separators between the old words are kept (all of them with as
   many words on both sides, the first ones otherwise), so manual line breaks stay. Styled run boundaries inside the
   region move to the same place in the replacing word (as many words) or proportionally; paragraph settings are
   renumbered when a line disappears. `caption.words` (content time, the new words' times mapped through the clip)
   and the text are written together, so the per-transaction upkeep does not re-time anything and rebuilds the
   highlight (Source Text keys for word / karaoke, runs for keywords; `normalize.ts`). The clip keeps its id, effects
   (template animation keys), linked text style and overrides; its auto name follows the text; its box is laid out
   again (`layoutText`).
5. **Re-break only offending lines** (`rebreakSplices`): a line longer than the group's `maxChars` with more than one
   word is broken with `breakLines` (weak words kept with what follows); other breaks, manual ones included, stay.
   Only if that makes more lines than the group allows is the whole subtitle broken like a generated one.
6. **Skips** (left unchanged, reported in the result and the plan as `skipped: [{clipId, sequenceId, kind, groupId?,
   trackId, edits, reason}]`, plus `W_TRANSCRIPT_PATCH_SKIPPED` warnings for the first 20): `edited` (words there or
   the text no longer match), `source-text-keyframes` (hand-made Source Text keys — not the highlight's — hold a copy
   of the clip's text), `expression` (a Source Text expression makes the text), `locked` (track locked), `reversed`,
   `split`. The transcript is fixed in every case.
7. **Older caption-track clips** (SC-052): caption clips whose private transcript (`mediaId: null`) was made from
   speech or by hand (`origin` ≠ `subtitle-file`: imported caption files have their own text and are never touched)
   are matched the same way (identity display) and their words spliced (breaks and speaker keys kept, new words
   clamped between their neighbours). Caption clips that reference a media transcript follow it by themselves.

### `planReplaceWords` (SC-053)

`planReplaceWords(doc, input) → {ok, problem?, transcriptId, edits: [{index, start, end, from, to, before, after}],
patched: [{clipId, sequenceId, kind: 'subtitle' | 'caption', groupId?, trackId, edits, before, after}], skipped:
[...], stale: [{index, start, end, expect, actual}]}`. Pure, never throws (a stale or malformed input is `ok: false`
with the code the command would refuse with). The command applies exactly `computeReplaceWords`, whose report this
is (tests compare both). Used by proposal dry runs (the accept / revalidate path runs the command in a dry-run
transaction, so a stale `expect` makes the item stale with reason `E_STALE: …`, SC-062), and by the Review / MCP.

### Downstream (SC-054)

No new code: a fix changes the transcript, so the Clean Up review's `analysisInputsChanged` reports it stale; the
detector's finding fingerprints hash normalised text, so findings over fixed words get new fingerprints and stored
rejections stop matching them; engine / MCP analyses record the document revision (`apply_cleanup` → `E_STALE`).
`scriptFix.configure` touches neither transcripts nor clips, so it does not make a Clean Up review stale. Tests:
`packages/project/test/script-fix-proposal.test.ts`, `apps/web/test/script-fix-review.test.tsx`.

### `Sequence.scriptFix` and `scriptFix.configure` (SC-055)

`{rejected?: string[], settings?: {strictness?, sources?, scope?}}` (`packages/project/src/script-fix/sequence-state.ts`):
lenient read (`readSequenceScriptFix`, `scriptFixSettingsOf` with defaults Standard / script + glossary / whole
recordings, `scriptFixRejected`), INV-SCRIPTFIX, `repairDocument` (`repair-script-fix`). No schema bump — row and the
verification in `docs/project-files.md` "Optional fields added since v10 (no bump)". Command `scriptFix.configure
{sequenceId?, settings?: {...} | null, reject?, unreject?, clearRejected?}`: settings merged field by field (null
clears), rejections added / removed / cleared (cap 10 000 → `E_LIMIT`), one undo step. Fingerprints are the aligner's
(SC-026); the format accepted is any 1–512 characters without control characters (assumption agreed with the
coordinator so the aligner's format can evolve).

### Proposal feature and default selection (SC-060 / SC-061 / SC-062)

- `transcript-correction` in `PROPOSAL_FEATURES`: "Transcript fixes", "1 fix" / "{0} fixes", groups `fix` (Fixes),
  `spelling` (Spelling), `maybe` (Maybe), Project Settings agent policy default on, `agentAllExcludes: ['maybe']`.
  `transcript-cleanup` lost its unused "Transcript fixes" group.
- Per-item default selection (`ProposalItemInput.selected?: boolean`, stored only when false). Accept of "all" =
  selected pending / stale items (`acceptAllItemIds`, used by `composeAcceptTx`, `planAccept`, the engine route and
  MCP); named ids take any item. An agent's "all" (engine for non-editor requests, MCP) never takes the `maybe` group,
  even if an item there is stored selected. Session `ReviewItem.selected`; the Review marks unselected rows "Not
  selected", Accept all leaves them pending; MCP `get_proposal` shows `selected: false`, `accept_proposal` returns
  `notSelected` (and refuses with a hint when nothing is selected). Engine proposal files with `selected` are read by
  this build only (the store is app state, not versioned with the project; an older engine moves such a file aside as
  unreadable — limitation).
- Item builder `transcriptFixItem(candidate, decision, edit, {id?})` (`script-fix/proposal-item.ts`): candidate
  `{transcriptId, mediaId, kind, category, asr, script, start, end, contextBefore, contextAfter, fingerprint}`, decision
  `{group, rule, deltaTok}`, `edit` = the aligner's `replaceWordsEdit` `{start, end, expect, words}`, used **verbatim**
  (audio-retimed fixes span previous word end → next word start; a `del` edit may take in a neighbouring word, so the
  edit is never rebuilt from the candidate's own span) → item `{id: transcriptFixItemId(fingerprint), label "expect →
  words", group, commands: [transcript.replaceWords {transcriptId, edits: [edit]}] (subtitles and caption tracks
  patched), meta: {group, kind, category, asr, script, deltaTok, rule, mediaId, start, end (= the edit's span),
  contextBefore, contextAfter, fingerprint}, selected: false for maybe}`. A malformed edit (words outside the span,
  spaces in a word, unsorted…; `transcriptFixEditProblem`, the command's own validator) throws a RangeError naming it.
- Staleness (SC-062): an item whose `expect` no longer matches fails its dry run with `E_STALE` → `stale` with
  `problem: {type: 'conflict', issue: 'E_STALE: …'}`; all-or-nothing accepts refuse, `partial` applies the rest.
  Refresh (re-running alignment for the affected media) is the job package's refresher (`scengine`).

### Verification (build VM, `wt-scapply`)

`pnpm exec vitest run` on `packages/project/test/script-fix-{apply,state,proposal}.test.ts`,
`packages/project/test/proposal-features.test.ts`, `packages/session/test/script-fix.test.ts`,
`apps/web/test/script-fix-review.test.tsx`, `apps/mcp/test/script-fix.test.ts`, `apps/engine/test/proposals-features.test.ts`
(property tests: replaceWords on random transcripts and edit sets — invariants, exact splice, plan = command, previous
document untouched, 120 runs; the scriptFix repair on arbitrary values). Typecheck of project, session, web, engine,
mcp; biome on the touched files; `check-layers`, `check-tokens`; `pnpm i18n` / `pnpm i18n:check`.

### Limitations

- Subtitles laid out from another transcript of the media (not its current one) are not patched (they no longer match
  what the sequence transcript shows either).
- A subtitle whose words were re-timed by hand far from the transcript (no midpoint overlap) is not recognised; it is
  then neither patched nor reported.
- Reversed subtitle / caption clips are skipped (`reversed`), not patched.

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

## Personal glossary

Work package `scglossary` (spec 17 SC-070, SC-071 helpers, SC-072, SC-091 glossary tools). The user's own list of
names and words the speech recogniser gets wrong: a right spelling (`to`) with the spellings Whisper writes for it
(`from`), optionally for one language, and how often the user taught it (`count`).

### Storage (`apps/engine/src/speech/glossary.ts`)

- One file per app dir: `<appdir>/speech/glossary.json` (`paths.speechGlossaryFile`), shared by every project,
  editor window and agent; app state, not the project (no schema change). Format
  `{format: "jasper-speech-glossary", version: 1, revision, entries: [{id, from, to, lang?, count, createdAt,
  updatedAt}], invalid?}`.
- Writes are serialised and atomic (`atomicWriteJson`: temp file, fsync, rename, directory fsync); the in-memory state
  moves only after the write, so a failed write (disk full) changes nothing. Every change bumps `revision` and
  publishes `glossary.changed {revision}`; a save that changes nothing writes nothing.
- Opening repairs conservatively and reports each repair in `GET /api/speech/glossary` `repairs` (shown in
  Preferences): an unreadable file (not JSON, not an object, another `format`, no valid version) is renamed
  `glossary.json.corrupt-<time>` and an empty glossary starts; entries that no longer validate, duplicate ids,
  duplicate target + language pairs and entries beyond 2,000 are kept aside in `invalid` and written back, never
  dropped.
- A file with `version > 1` is listed (known fields only) with `readOnly: true` and never rewritten; every write is
  refused with 409 `GLOSSARY_READ_ONLY` (MCP `E_READ_ONLY`).

### Rules (`packages/project/src/glossary/schema.ts`, pure)

- Texts are cleaned (NFC, control characters and line breaks as spaces, single spaces, trimmed) and must be 1–64
  code points with a letter or digit. ≤ 20 spellings per entry, ≤ 2,000 entries (`GLOSSARY_LIMITS`).
- Spellings are compared without case (the recogniser's casing is not a spelling) and never equal the target; the
  target is exact and case-sensitive ("NovaPlay" and "Novaplay" are different spellings). Assumption (not in the
  spec): an entry is keyed by target + language; an entry without `lang` and one with `lang: "es"` are separate.
- Save = add, or merge the new spellings into the entry with the same key (idempotent). Remember = the same and
  `count + 1` (a new entry starts at 1, a saved one at 0). A spelling may belong to several entries: deciding between
  targets is the audio check's job (SC-073), so nothing is silently moved between entries.
- Edit replaces fields; a key another entry has is refused (`GLOSSARY_DUPLICATE`). Import (`parseGlossaryImport`)
  reads an exported file or a bare list `[{from, to, lang?}]` leniently (`from` may be one string; ids, unknown keys
  and bad dates ignored), skips unusable entries with a reason and their position in the file, refuses another format
  or a newer version as a whole, reads at most 10,000 entries; merging is additive (new spellings up to 20, the larger
  count, the earlier creation date; the rest reported).

### Routes, client, events

| Route | Client method | Notes |
|---|---|---|
| `GET /api/speech/glossary` | `listGlossary()` | `{revision, readOnly, repairs, limits, entries}` |
| `GET /api/speech/glossary/export` | `exportGlossary()` | the importable file (entries kept aside are not exported) |
| `GET /api/speech/glossary/:entryId` | `getGlossaryEntry(id)` | 404 `GLOSSARY_NOT_FOUND` |
| `POST /api/speech/glossary` | `saveGlossaryEntry({from, to, lang?})` | 201 created / 200 merged; `{revision, created, changed, entry}` |
| `POST /api/speech/glossary/remember` | `rememberGlossaryEntry({from, to, lang?})` | SC-071 Remember: same, `count + 1` |
| `PUT /api/speech/glossary/:entryId` | `updateGlossaryEntry(id, {from?, to?, lang?: string \| null})` | an agent dropping spellings or changing the target needs the user's approval |
| `DELETE /api/speech/glossary/:entryId` | `removeGlossaryEntry(id)` | an agent needs the user's approval (`requireUserApproval`, AGT-3) |
| `POST /api/speech/glossary/import` | `importGlossary(file)` | `{revision, added, merged, unchanged, skipped: [{index, reason}]}`; 400 `GLOSSARY_IMPORT_INVALID` |

Request bodies are zod-validated at the route (`packages/api/src/glossary.ts`; strict objects, bounded strings and
lists) and then cleaned and checked by the rules (400 `GLOSSARY_INVALID`, 409 `GLOSSARY_LIMIT`). Event:
`glossary.changed {revision}`.

### "Replace all N" finder (`packages/project/src/glossary/replace-all.ts`, SC-071)

`findReplaceAllInSequence(doc, sequenceId, {oldWords, newText, exclude?}) → {occurrences, commands, truncated}` (and
`findReplaceAll(transcripts, query)`, `sequenceMediaTranscripts(doc, sequenceId)`). It searches the media transcripts
of the sequence's audio clips for the same run of words compared with `normalizeWord` (markup and edge punctuation
removed, lower case, accents kept) and returns plain data in the `transcript.replaceWords` edit shape of SC-050:
`{start, end, expect, words: [{text, start, end, confidence: null}]}` per occurrence and one
`{type: 'transcript.replaceWords', transcriptId, edits}` per transcript, edits sorted by time and disjoint. Each
occurrence keeps its own leading ¿ ¡ « “ ( and trailing . , ; : ! ? … » ” ) (the correction's own edge punctuation is
dropped), gets a capital first letter where the recogniser capitalised the first old word (as SC-031 does for
readings; the user's casing is kept otherwise — an assumption), and its span is split among the new words by
character count (like `transcript.editText` and SC-042). Left out: the edited span (`exclude`), occurrences that
would not change, spans shorter than the word count, and empty corrections (deleting everywhere is not a spelling
fix). Bounds: ≤ 20 query words, ≤ 1,000 characters, ≤ 5,000 occurrences (the rest counted in `truncated`). The
command itself is the `scapply` package's; the offer in the Transcript tab is `scweb`'s.

### MCP (`apps/mcp/src/tools/glossary.ts`)

`list_glossary {query?, lang?}` (read-only), `save_glossary_entry {to, from, lang?}` (idempotent edit),
`remove_glossary_entry {entryId}` (destructive, idempotent; the engine asks the user in an open editor window).
Strict schemas and the four annotation hints (`conventions.test.ts`); refusals map to `E_READ_ONLY`, `E_LIMIT`,
`E_INVALID_PARAM`, `E_NOT_FOUND`, `E_APPROVAL_DENIED`. `GLOSSARY_GUIDE` is part of the `jasper://guide` resource.

### UI (`apps/web/src/speech/GlossaryPage.tsx`)

Edit ▸ Preferences ▸ Transcription ▸ Glossary (a sub-page: the Preferences registry gained `parent`, listed indented
and titled "Transcription ▸ Glossary"), also Edit ▸ Preferences ▸ Speech Glossary… (command `speech.glossary`, no
default shortcut). List sorted by target with language and count, search over targets and spellings, New Entry and
Edit… inline (spellings one per line or comma-separated, language "Any language" or a Whisper language), Delete after
a confirmation (no undo), Import… (summary with skipped reasons) and Export… (`glossary.json`), the read-only banner
(editing disabled, export kept), the repair notice, load failures and the engine's refusals shown on the page. Design
tokens only; English and Spanish strings.

### Validation (build VM, 2026-10-27)

- `packages/project/test/glossary.test.ts` (rules, caps, import parser with a fast-check property: never throws, only
  storable entries, bounded, idempotent re-import), `glossary-replace-all.test.ts` (finder, fast-check property:
  sorted, disjoint, inside the span, `expect` equals the transcript words, deterministic).
- `apps/engine/test/speech-glossary.test.ts` (atomic write and restart, a failed write changes nothing, corrupt file
  moved aside and reported, invalid / duplicate / over-the-cap entries kept aside, newer version read-only, route zod
  refusals, merge, Remember, edit, export → import round trip, approval for an agent's delete and lossy edit).
- `packages/engine-client/test/glossary.test.ts`, `apps/mcp/test/glossary.test.ts`, `apps/mcp/test/conventions.test.ts`,
  `apps/web/test/glossary-preferences.test.tsx`.
- Exercised in the VM dev stack (engine 47944, vite 5214): a corrupt file reported, add, merge, Remember counts,
  duplicate-target refusal shown in the form, delete after confirmation, import with a skipped entry, export download,
  read-only file, Spanish UI.

### Limitations

- The "Replace all N" / "Remember" offers after a manual edit are `scweb`'s; glossary candidates (SC-073) are
  `scalign`'s; glossary prompting (SC-074) is `scscore`'s. Until they land the glossary is maintained in Preferences
  and through MCP only.
- Repair messages come from the engine in English (as for the font library).

## Accuracy on real recordings (SC-105)

Work package `sccalib`: the scriptfix spike's measurements repeated with the editor's own code — the TS model
(`parseScript` → `alignTranscript` → `findFixCandidates` → `buildScoreWindows` / `scoreRequestWindows` →
`candidateScores` → `decideFix`) and the `jasper-speech score` worker with ONNX fp32 turbo — on the spike's 16 raw
recordings of the user (78 min of speech, 13,381 words), each aligned to its whole script file. The harness (private,
not in the repo) bundles the TS with esbuild and runs on the user's Mac; transcripts, scripts and audio stayed there,
only aggregates and text-only derived rows left it. Aggregates only below; no transcript text, names or items.

### Conditions

- Mac: Apple M4 Max (14 cores, 36 GB), macOS 26, Node 22.21.1 (the repo code needs nothing newer), onnxruntime-node
  1.30.0, 8 threads (the engine's thread cap). On AC power (the 96 W charger; `pmset`: AC Power, battery 100 % charged), Low Power Mode off
  (`pmset` `powermode 0` before and after every job, logged); the shared heavy-compute lock held for every scoring run;
  the user's desktop apps open (load average 2.3–2.6 before the runs, up to ≈ 10 during CPU scoring including the
  job itself).
- Model: `whisper-large-v3-turbo` fp32, the pinned catalogue files (all six sha256 equal to
  `apps/engine/src/processing/models.json`).
- Audio: the recordings' 16 kHz mono extractions, decoded by the worker through ffmpeg like engine media; no voice
  analysis (the energy VAD refines times, as when none exists).
- Same inputs as the spike: its turbo transcripts; its corrupted scripts (558 corrupted words: 194 phonetic
  neighbours, 174 same-category words, 190 random words) and injected transcripts (430 operations) rebuilt from its
  job definitions; its blind text-only labels (179 candidates: 52 recognition errors A, 46 real deviations R,
  9 no-fix-wanted N, 16 hallucinations H, 56 unclear U), mapped to the editor's candidates by region (same recording,
  overlapping times, a shared script or ASR word); the cleanup calibration's off-script / head-tail / hallucination
  labels.
- Decisions with the Standard preset unless named; "fix" = the Fixes and Spelling groups (Maybe items are offered
  unselected and are not counted as fixes).

### Results (Standard; CPU and WebGPU give identical decisions)

| SC-105 target | Measured | Met |
|---|---|---|
| Corrupted-script false fixes ≤ 0.5 % of corrupted words | 1 of 558 (0.18 %): phonetic neighbours 1 / 194, same category 0 / 174, random 0 / 190 | yes |
| 0 fixes in the cleanup's off-script / head-tail / hallucination regions | 0 audio fixes (hallucination: 1 Maybe, 1 kept); 1 spelling-only join in a head-tail slate (a spoken name glued by the recogniser, same letters split as the script writes it) | audio fixes yes; strictly 1 join |
| Adjudicated recognition errors fixed ≥ 70 % | 38 of 52 (73 %); 7 Maybe, 7 kept | yes |
| … with 0 real deviations fixed | 0 of 55 (R + N); unclear: 15 of 56 fixed (agreement / homophone cases at Δ_tok ≈ 0, script wins) | yes |
| Injected errors restored ≥ 50 % | 245 of 430 (57 %; 95 % of the 257 that got a candidate): phonetic 101 / 139, function swap 69 / 96, dropped word 68 / 99, glued 7 / 69, split 0 / 27 | yes |
| … and ≥ 50 % of proper-noun splits / glues (the `join` rule) | 5 of 10 (50 %) whose script side is proper by SC-023; 3 of 4 by the spike's hand list (every one was a glue; no split hit a proper noun) | yes (at the limit) |
| Natural fixes per speech minute | 2.49 (194 of 412 candidates: 96 audio, 37 spelling rule, 10 `del`, 51 joins); Maybe 0.82 | — |
| Cost per speech minute, CPU | 4.27 s: encoder 3.95 s (1.24 s per window, 3.2 windows per speech minute), decoder 0.21 s (28 ms per reading), rest of the scoring 0.11 s, alignment 0.005 s; + model load 0.26 s and audio decode 0.92 s per job (amortised) | measured |
| Cost per speech minute, WebGPU (encoder; decoder on the CPU, the scoring plan without calibration) | 2.29 s: encoder 1.96 s (0.61 s per window), decoder 0.21 s, rest 0.11 s, alignment 0.005 s; + model load 0.37 s and audio decode 0.91 s per job (amortised) | measured |

- Alignment (TS): 79.7 % of transcript words exact, 14.0 % off-script, 428 retake jumps, no capped rows; parse 28 ms,
  align 375 ms, candidates 6 ms, windows 1 ms for all 16 recordings (Node 22, median of 3).
- Re-timed fixes (133 audio-decided `sub` / `merge`): new region start vs the old one p50 10 / p90 30 ms, end p50 10 /
  p90 180 ms.
- Margin sweep (same runs): Careful 0 false fixes, 32 / 52 A, 0 R + N; Generous 2 false fixes, 42 / 52 A, 1 R + N
  fixed. Audio margin −2 with the spelling rule: 2 false fixes, 1 real deviation fixed; spelling margin −8: 2 false
  fixes. The spike's margins (−1.5, spelling −5, `del` 0) stay.

### Δ_tok: ONNX fp32 (editor) vs mlx fp16 (spike)

| Readings | spike mlx fp16 | editor ONNX fp32 |
|---|---|---|
| corrupted phonetic neighbours: p50 / p99 / max | −9.75 / −2.34 / −1.82 (n 240) | −10.29 / −2.34 / −1.80 (n 235) |
| corrupted same category | −12.64 / −3.69 / −2.54 | −14.00 / −3.64 / −2.38 |
| corrupted random | −12.60 / −4.74 / −4.06 | −13.20 / −4.69 / −4.01 |
| adjudicated A: p25 / p50 / p75 | −2.85 / −1.40 / −0.68 | −3.31 / −1.73 / −0.72 |
| adjudicated R: p25 / p50 / p75 | −9.08 / −6.32 / −4.25 | −9.13 / −6.45 / −4.22 |

Paired on the same corrupted word (n 328): editor − spike median −0.22 nats/token, p10 −1.70, p90 +1.11. The
precision tail (corrupted p99 and max) is where the spike had it, so the −1.5 margin keeps its ≥ 0.3 nats/token gap;
recognition errors score ≈ 0.3 lower in the median, which costs a few borderline fixes (Maybe) rather than adding false
ones. WebGPU vs CPU: every decision of every preset equal (2,070 candidates), |ΔΔ_tok| ≤ 0.0007.

### Changes made from these measurements (before → after, same harness)

| Run (CPU, Standard) | false fixes | cleanup regions | A fixed | R + N fixed | injected | proper glues | fixes / min | CPU s / min |
|---|---|---|---|---|---|---|---|---|
| Code as merged (packed windows; C and J of one recording refused) | 2 / 544 | 1 audio + 1 join | 35 / 52 | 2 / 55 | 240 / 418 | 4 / 8 | 2.37 | 3.67 |
| Windows not packed | 1 / 544 | 1 join | 35 / 52 | 0 / 55 | 237 / 418 | 4 / 8 | 2.43 | 4.31 |
| + names written both ways count as proper (final) | 1 / 558 | 1 join | 38 / 52 | 0 / 55 | 245 / 430 | 5 / 10 | 2.49 | 4.27 |

1. **Score windows always satisfy the SC-092 request limits (bug).** A hallucination loop ("cab cab cab …", 238 words
   in 23 s) made one window exceed the 224-word reading limit, and the worker refused the whole scoring job of that
   recording (the corrupted and injected runs of one recording failed). Now: stretches over `maxWords` (100) are split
   at their largest gap, more than 63 candidates of one window go into further windows over the same audio, reading
   ids are short (`r1`…; candidate ids carry the media id and could pass 128 characters), unreadable words (empty or
   over 128 characters) are left out with their candidates `unplaced`, and no window exceeds 30 s
   (`test/script-fix-windows.test.ts`, fails before the fix; fast-check property). Ordinary speech has ≤ 89 words and
   ≤ 117 tokens per 28 s window here, so nothing else changed.
2. **Windows are not packed by default.** The two real deviations, the hallucination-region fix and both corrupted
   words fixed by the merged code sat in packed windows with few words for their length (4–32 words over 12–25 s,
   largest gaps between stretches 3.6–17.6 s): speech the transcript missed in those gaps let a reading take that
   audio (one candidate's forced times landed 15 s after its words, Δ_tok +0.80 where the spike had −3.59). Unpacked
   windows (the spike's own windowing) fixed none of them, for 23 % more encoder passes (249 vs 204; 3.2 per speech
   minute). The one false fix left (a corrupted English word, Δ_tok −4.91 in a 2 s window) is the spelling rule's
   known loose end (F§5.1). `pack: true` stays available. Limiting Δ to the region plus a few following words instead
   was tried and did worse (more real deviations fixed).
3. **Names the script writes both ways are proper (SC-023).** A word capitalised mid-sentence in at least a third of
   its occurrences now counts as proper even when it is also written in lower case (the vote rule needed a majority).
   It gave a misrecognised channel name the spelling rule: recognition errors fixed 35 → 38, no new false fix, natural
   fixes 2.43 → 2.49 per speech minute.

### Limitations

- Labels are text-only (the spike agent's blind judgement without listening); "unclear" cases are not counted either
  way; there is no verbatim ground truth.
- In-sample: the margins, both rule changes and the label mapping were judged on the same 16 recordings (no held-out
  set); expect somewhat lower figures on new videos. The proper-noun change rests on one name.
- The proper-noun split/glue target is met at the limit on n = 10 (all glues; injected splits never fell on a proper
  noun), so it is weak evidence.
- Corrupted and injected errors are synthetic and easier than natural ones.
- One join changed the spelling of a name in a head-tail slate: joins are decided without audio and cannot know about
  cleanup regions (it did not rewrite what was said).
- SC-030 / SC-037: the spec's packing is off by default now; the VM cost on real recordings is estimated at ≈ 17.5 s
  per speech minute unpacked (basis: the VM's measured 5.05 s per window and 0.17 s per reading × this corpus's 3.2
  windows and 7.7 readings per speech minute), under the 20 s target; the lj-composite VM figure (19.0 s packed,
  49.6 s unpacked) is for dense read speech with a pause every sentence.
- Audio came from 16 kHz extractions, not the original media containers; no voice analysis was available to the
  re-timing.
- Rerun: harness in the private research folder `sccalib` (`mkinputs.py`, `sccalib.ts`, `run.sh`, `scfinal.py`).
