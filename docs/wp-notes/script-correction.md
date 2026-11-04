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
  - Consecutive stretches are packed into windows of ≤ 28 s (spec addition) with their gaps muted: `ScoreWindow.mute`
    lists the media ranges between the stretches' padded ranges, heard as silence by the scorer (SC-105 harness, see
    "Accuracy on real recordings"). `pack: false` (unpacked) and `muteGaps: false` (unmuted packing) are options.
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
| | length | ≤ 28 s and ≤ 100 words, packed with muted gaps |
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
  (measured with window packing; the default packs with muted gaps since the SC-105 follow-up).
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
- **Muted gaps (SC-030)**: a window's optional `mute` (request: media flicks, rounded inwards to whole samples by
  `SpeechService.score`; worker spec: samples inside the window, ≤ 64 ranges, refused otherwise) is heard as silence:
  the window's frames are those of its audio with those samples set to zero. Frames whose 25 ms window lies inside a
  range are digital silence (`log10(1e-10)`); frames straddling a range edge are recomputed from the samples
  (`MelFrameComputer`, the stream's own arithmetic) — the worker keeps ± 400 samples around every edge while decoding
  (`keepRanges`, no whole-file sample array); all other frames are the streamed ones. Frames are never dropped, so word
  times stay absolute; normalisation keeps the whole file's maximum; the encoder cache key includes the ranges. Tests:
  `speech-score.test.ts` (the encoder input equals that of the same window with the samples zeroed, untouched frames
  unchanged, refusals, `MelFrameComputer` = the stream), `speech-score-service.test.ts` (flicks → samples),
  `packages/api/test/speech-score-schema.test.ts`.
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

## Fix job, API and MCP

Package `scengine` (spec 17 SC-014, SC-016, SC-035/036, SC-053, SC-055, SC-061…063, SC-073, SC-090, SC-091 without
the glossary tools, SC-092 use). Code: `apps/engine/src/transcript-fix/run.ts` (pre-flight, pipeline, job, refresher,
accept / reject hooks), `transcript-fix/costs.ts` (measured cost for the estimate), `routes/transcript-fix.ts`,
`packages/api/src/transcript-fix.ts` (request / result schemas, job kind `transcript-fix`, route `transcriptFix`),
engine-client `transcriptFix`, MCP `apps/mcp/src/tools/transcript-fix.ts`.

### Route and job (SC-090)

- `POST /api/projects/:projectId/sequences/:sequenceId/transcript-fix[?wait=1]` body `{sources?, scope?, strictness?,
  showRejected?, mode?: 'propose' | 'dryRun', device?}` (strict zod; unset fields = the sequence's
  `Sequence.scriptFix.settings`, else script + glossary / whole recordings / Standard; `mode` default propose) → 202 a
  `transcript-fix` job. The same request (same settings, mode, device, requester kind) on the same document revision
  while its job is queued or running returns that job (queue dedupe key). Authenticated like every route; an agent's
  job has an agent origin and its proposal is the agent's.
- Refused at once (the job repeats the checks on the document it reads): unknown sequence 404 `E_NOT_FOUND`; nothing to
  fix from (no script attached / script source off, and no glossary entry / glossary off) 409 `E_NO_SOURCE`; no
  transcribed words in scope 409 `E_NO_TRANSCRIPT`; scope In–Out without marks 400 `E_INVALID_PARAM`; to propose, no
  installed speech model that fits the transcripts' language 409 `E_NO_SPEECH_MODEL` (the dry run still answers and
  reports `speech.problem`). A translated transcript (`task: translate`) is left out with `W_TRANSLATED`.
- Steps per media, one at a time (bounded memory: the alignment path is dropped after candidates; ≤ 20,000 candidates
  per job, the rest counted in `guard.candidatesCapped`): `parseScript` per language (cached) → `alignTranscript`
  (SC-014: each media transcript against the whole script; `E_LIMIT` from the aligner = the job error `E_LIMIT` with
  its detail) → `findFixCandidates` with the personal glossary (SC-073, `SpeechGlossary.list`) and
  `Sequence.scriptFix.rejected` (skipped unless `showRejected`; re-offered ones unselected) → the scope filter →
  `decideFix` without audio for joins / glossary spellings → `buildScoreWindows`.
- Scope (SC-063): `recordings` = every media transcript (`transcriptForMedia`) of the sequence's audio clips on audio
  tracks, in the order the sequence first plays them; `used` = the words `sequenceWords` maps into the sequence (top
  track first, midpoint rule); `inOut` = those whose sequence-time midpoint is in [In, Out) (In default 0, Out default
  the end, the export's rule). The whole recording is still aligned (anchors and the report stay meaningful); only
  candidates whose words — for `del`, both neighbours — are in scope are kept (`skipped.scope`). Nested sequences are
  not descended (assumption: the speech is on the sequence's own audio clips).
- Audio check (`propose`, SC-035/036/092): one `SpeechService.score` call per media with all its windows: request
  `mediaId` = the asset's engine-store key (not the project media id), `language` = the transcript's, `model` = the
  transcript's model when installed and fitting, else the default, else any installed model fitting the language;
  `device` from the request. Windows with more than 64 readings are split into windows of the same range (still one
  encoder pass); a window over 30 s or with a reading over 224 words / a word over 128 characters is not sent (its
  candidates are kept, `skipped.unscorable`, `W_UNSCORABLE`). Progress = the worker's per-reading progress weighted by
  each media's windows (0.15…0.9 of the job); the job's signal cancels the worker (≤ 1 s). `ASSET_NOT_FOUND`,
  `MEDIA_OFFLINE`, `NO_AUDIO`, `SPEECH_LANGUAGE_*` (and no engine-store key, a transcript language that is not a code)
  leave that media unscored (`perMedia[].unscored`, `W_UNSCORED`; its audio candidates are kept); any other scoring
  failure is the job error with the worker's code (`SPEECH_SCORE_FAILED`, `SPEECH_MODEL_*`, refusals…), retryable as
  reported. `candidateScores` → `decideFix` with the strictness preset → `replaceWordsEdit` → `transcriptFixItem(c, d,
  edit, {id})` (item id from the candidate id, so repeated takes get distinct ids; Maybe and re-offered rejected
  fixes `selected: false`; a malformed edit is a producer bug: left out with `W_FIX_MALFORMED`, never a crash).
- Patch report (SC-053): one `planReplaceWords` per transcript over all its edits (each edit alone if they do not
  compose) → `{edits, patched (distinct clips), skipped [{clipId, sequenceId, kind, reason}] (≤ 200), stale}`.
- Proposal (SC-061): ONE `transcript-correction` proposal "Fix transcript" (items in time order per media; over 2,000
  items Maybe ones are dropped first, then the latest: `guard.itemsCapped`), summary "N fixes · N spelling · N maybe
  (unselected) in N recordings · N % aligned", `report = {format: 'jasper-transcript-fix', version: 1, settings,
  device?, mediaIds, counts, perMedia}` (what refresh needs). Nothing to fix → no proposal (`proposalId: null`).
- Result `{mode, projectId, sequenceId, proposalId, itemCount, revision, report}` with `report = {settings,
  sourcesUsed, perMedia: [{mediaId, transcriptId, name, language, words, wordsInScope, alignment (the aligner's
  AlignmentReport, SC-016), candidates, windows, readings, unscored?}], candidates: {total, byGroup (fix, spelling,
  maybe, keep; dry run: pending), byCategory, byKind}, decisions (≤ 2,000, `decisionsTruncated`), skipped (counts by
  reason), unusedLines (all media together), patch, speech {model, problem?}, device, fallback?, estimate? (dry run),
  timings {readMs, alignMs, scoreMs, decideMs, totalMs, speechSeconds, speech?}, guard?, warnings}`.
- `dryRun` (agreed with the coordinator): steps 1–6 and 9 only — no audio check, nothing stored. `estimate` =
  Σ per media (load + windows × per-window + readings × per-reading) seconds with `basis: 'measured'` when every
  scored media's model has a measurement on this machine (`<appdir>/engine/transcript-fix-costs.json`, written
  atomically after each audio check from the worker's timings; unreadable → ignored and rewritten), else `reference`
  (the build-VM SC-037 figures of the scoring section: 6.4 s load, 5.05 s per window, 0.17 s per reading). Labelled
  "≈" with its basis.

### Refresh, accept, rejections (SC-055, SC-062)

- Refresher of `transcript-correction` (Refresh proposal / `refresh_proposal`): the proposal's settings are re-read
  from its report; only the media of the requested items are re-aligned, and only windows holding candidates whose item
  ids were requested are scored. A requested item comes back re-planned (same id: fingerprint-based, so it survives a
  changed `expect`), or dropped ("no longer disagree", "the audio check now keeps the transcript", "could not be
  checked again"); a source that disappeared drops them all with the refusal's message.
- Accept: `ProposalService.registerAcceptExtension` (new, generic) appends to the accept transaction of a
  `transcript-correction` proposal one `scriptFix.configure {reject, unreject}` — the fingerprints of the proposal's
  rejected items not yet remembered (capped so the list stays ≤ 10,000) and the remembered ones of items accepted now
  (re-offered with "Show rejected") — and sets the History label "Fix transcript: N fixes". One undo step. Mirrors
  Clean Up, whose Apply remembers explicit rejections in the same transaction (`cleanupApplyCommands`).
- `registerRejectListener` (new, generic): when the editor's rejection leaves nothing pending or stale, the rejected
  fixes are remembered in their own step ("Fix transcript: remember N rejected fixes", as the user, never asking
  approval). An agent withdrawing its own items is not the user's rejection and records nothing. Rejections of a
  proposal that is deleted while items are still open are not remembered (limitation).

### MCP (SC-091)

- `fix_transcript {projectId, sequenceId?, mode (required), sources?, scope?, strictness?, showRejected?, device?,
  timeoutSeconds?}`: strict schema, hints `EDIT` (not read-only: it stores a proposal; not destructive: nothing
  changes until accepted), waits for the job with progress notifications, cancelling the request cancels the job;
  failures are tool errors with the job's `E_*` code; the result is the report compacted (100 decisions shown).
- `attach_script` now says the script serves cleanup and transcript fixing. Guide resource
  `jasper://guide/transcript-fix` "Fixing transcripts from a script" (with the glossary guide) and `TRANSCRIPT_FIX_GUIDE`
  in the server instructions; the editing-automation guide's workflows start with fixing the transcript.

### Tests (build VM)

- `apps/engine/test/transcript-fix.test.ts` (16, fake scorer at the `SpeechService` boundary): zod refusals, no
  source / no transcript / In–Out / no model (and the dry run without a model), the dry run (no scoring, groups
  `spelling` / `pending`, reference estimate, nothing stored), the proposal (fix + spelling selected, Maybe unselected,
  kept candidate absent, engine media key and language in the request, patch report), accept "all" + a rejected item
  (transcript fixed, Maybe left, `scriptFix.rejected` = the fingerprint; re-run skips it; `showRejected` re-offers it
  unselected), an agent's "all" without Maybe, reject-all remembering three, refresh of a stale item (one score call,
  one window, new `expect`), scope `used` / `inOut`, the glossary source without a script, worker failure → job error,
  offline media → unscored, cancellation < 1 s, dedupe, `E_LIMIT`, measured estimate, the accept extension.
- `apps/mcp/test/transcript-fix.test.ts` (6): annotations and strict schema, the request body, dry run and propose
  results, progress notifications, cancellation → `cancelJob`, a refused job's `E_*` code, the guide resources.
- `apps/engine/test/transcript-fix.e2e.test.ts` (real model, gated like `speech-model.e2e`): the LJ fixture
  transcribed by whisper-tiny.en, 10 words corrupted with the confusions of `speech-score.e2e`, the true text as the
  script → exactly 10 items, all `fix`, each restoring its word with start / end within 100 ms of the true word; accept
  restores the transcript; the same accept transaction in an `EditorSession` is one undo step back to the exact
  document. The true transcript with a corrupted script → 0 fix / 0 spelling (measured: 8 kept, 2 Maybe — offered
  unselected: tiny.en's corrupted-script Δ_tok reaches −2.86, inside the Standard Maybe band, scoring section).

### Measurements (SC-037 integration, build VM, 2026-10-27)

`JASPER_SPEECH_MODELS_DIR=<dir> pnpm exec tsx apps/engine/bench/transcript-fix.ts` (`FIX_BENCH` line), under the bench lock; 16 shared EPYC-Rome vCPU, load
average 6.4 → 9.0 from other agents; whisper-large-v3-turbo fp32, CPU, 8 threads; the LJ fixture (0.966 speech
minutes by its utterance bounds), 10 candidates (≈ 10 per speech minute, the research's rate is 6.3), 3 packed windows,
13 readings; whole job from the request to the stored proposal, median of 3:

| Measure | Value |
|---|---|
| Job (read, align, score incl. model load and media decode, decide, patch report, proposal) | 30.2 s (29.8 / 30.2 / 31.0) = **31.2 s per speech minute** |
| of which the audio check (`scoreMs`) / everything else | 29.9 s / 0.06 s |
| Without the once-per-job load + decode (≈ 6.4 s, the scoring section's measurement) | ≈ 24.6 s per speech minute (estimate) |

This 1-minute clip is not representative: the once-per-job model load dominates a short job, and the clip has
≈ 1.6× the research's candidate density. whisper-tiny.en (functional e2e) took 7.2 s for the same job.

**Representative input (SC-037 measurement).** `pnpm fixtures` (recipe `scripts/fixtures/speech-long.mjs`:
`fixtures/media/lj-long.flac`, the LJ composite played 11 times, FFmpeg's native LGPL `flac`, 788.04 s, sample-exact
repeats) then `JASPER_SPEECH_MODELS_DIR=<dir> TRANSCRIPT_FIX_BENCH=1 pnpm exec vitest run
apps/engine/test/transcript-fix.bench.test.ts --maxWorkers=1` (`FIX_LONG_BENCH` line), under the bench lock. Input:
10.631 speech minutes in 11 takes read from ONE script (retakes); the composite's turbo transcript shifted per take;
per take 2 transcript words corrupted (real recognition errors, a different pair each take: 22 in all = 2.07 per
speech minute) and 4 script words corrupted (deviations the audio must keep) → 66 candidates = 6.21 per speech
minute (the research: 6.3, of which 1.9 real fixes). Build VM: 16 AMD EPYC-Rome vCPU (shared), engine queue 16 slots,
the speech worker on 8 threads (the speech thread cap), whisper-large-v3-turbo fp32, CPU; load average 3.4 before the
first run, 7.0–7.7 during the runs (other agents). Three full `transcript-fix` jobs (propose: request → stored
proposal), median:

| Measure | Value |
|---|---|
| Job wall time (139.3 s; runs 138.9 / 139.3 / 143.8 s) | **13.1 s per speech minute** (target ≤ 20 s: met) |
| model load (once per media) | 0.50 s per speech minute (5.3 s) |
| media decode (once per media) | 0.44 s per speech minute (4.7 s) |
| encoder (22 passes, one per packed window with candidates, 543.6 s of audio) | 9.41 s per speech minute (4.55 s per pass) |
| decoder (22 runs, 88 readings: 22 ASR + 66 candidate readings) | 1.33 s per speech minute |
| rest of the worker (mel, forced timing, I/O) / spawn and IPC | ≈ 1.2 / ≈ 0.1 s per speech minute |
| alignment, candidates, decisions, patch report, proposal | < 0.01 s per speech minute (36 ms + 2 ms + …) |

Decisions: 22 fix (every injected error), 11 Maybe (offered unselected; script deviations whose Δ_tok fell in the
Standard Maybe band), 33 kept; 0 spelling. (Measured with unmuted packed windows. Unpacked windows, the default for a
while, took 23.4–24.7 s per speech minute; the default since is packing with muted gaps: 13.62 s per speech minute,
the same 66 decisions — "Accuracy on real recordings (SC-105)", "Muted packed windows".) The encoder is 72 % of the job (zero-padded 30 s windows, one pass per
window with a candidate: 2.07 passes per speech minute); reading 0 is already scored once per window and each
distinct window encoded once, so the optimisations listed for SC-037 (reused model across jobs, batch / thread
tuning) were not needed and not made. The report now carries this split (`timings.speech`: load, decode, encoder,
decoder, worker scoring time, passes, runs, readings, encoded seconds). Mac and NVIDIA: not measured (SC-105 harness /
a GPU box).

### Limitations

- No web UI in this package (Fix dialog, Review rows: `scweb`). The engine and MCP paths are complete.
- The refresh runs inside the proposal's lock and is not cancellable (the request waits for the audio check of the
  stale items' windows).
- The estimate's per-model measurement does not tell devices apart (the last measured run of the model wins).
- Nested sequences are not descended for the scope; only the sequence's own audio clips count.

## Editor UI

Package `scweb` (spec 17 SC-001 UI, SC-002 summary, SC-053 notice, SC-071, SC-074 option, SC-080…086). Code:
`apps/web/src/script-fix/` (`model.ts` pure helpers, `engine.ts` the typed `transcriptFix` client calls,
`FixTranscriptDialog.tsx`, `FixRow.tsx`, `review.ts`, `EditOffer.tsx`, `source-audio.ts`), `commands/script-fix.ts`,
and changes to `panels/text/TranscriptTab.tsx`, `panels/text/cleanup/ScriptDrawer.tsx`, `panels/review/ReviewPanel.tsx`,
`proposals/actions.ts` / `review.ts`, `speech/GenerateTranscriptDialog.tsx` / `model.ts`, the menus and the keymap.

### Entry points (SC-080)

- Text ▸ Transcript toolbar: **Script…** (toggles the Script drawer; "Script ✓" when one is attached; also in the
  empty tab, so the script can be attached before transcribing) and **Fix Transcript…** (disabled read-only).
- Text panel menu: Script…, Fix Transcript…; Sequence ▸ **Fix Transcript from Script…** (after Clean Up Voice…).
- UI commands `transcript.fix`, `transcript.fixFromScript` (the Sequence menu's label: a menu entry shows its
  command's label) and `transcript.script`; none has a default shortcut (Keyboard Shortcuts can assign one);
  agent-exposed. Review keys added: Shift+Enter accept the current item's group, Shift+U back to pending
  (`proposals.acceptGroup` / `clearGroup`); `conflictsFor` finds no conflict in the Review scope chain (test).

### Script drawer (SC-001 / SC-002)

The existing `ScriptDrawer`, relabelled: History "Attach Script" / "Replace Script" / "Detach Script", button
"Replace". It now writes `cleanup.configure` for the sequence it is shown for (the Clean Up controller may be on
another sequence). Under the text: `parseScript(text).summary` — "3 sections · 160 words read · 1 direction (2 words)
and 2 headings skipped" — with the language of the sequence's first transcript.

### Fix dialog (SC-081)

- Fields: Fix from (Script with its name, Personal glossary with its entry count; a source that cannot be used is
  shown unchecked and disabled; one stays on), Scope (Whole recordings / Only what the sequence uses / In to Out,
  disabled without marks), Strictness (Careful / Standard / Generous with one line each), "Show fixes I rejected
  before (n, offered unselected)". The three settings are written with `scriptFix.configure {settings}` on each change,
  coalesced into one undo step ("Fix Transcript Settings").
- Dry run: every change (300 ms debounce, the older run aborted) runs `transcriptFix(…, {mode: 'dryRun'}, {wait})` and
  shows the aligned / off-script share (weighted by transcript tokens over the media), the candidate count by group
  (dry run: Spelling and "To check against the audio") and category, the ≈ time of the audio check with its basis
  ("on this computer (measured on earlier runs)" / "estimated from a reference machine"), the subtitles a fix could
  not update with the reasons (the patch report before applying, SC-053), media left unscored, `speech.problem` and the
  first warnings. The result is validated with `TranscriptFixResultSchema`.
- Run: the propose job, polled every 400 ms, progress bar and stage; Cancel (or closing) cancels the job. A proposal
  opens in Review (`openReview`, Review panel focused) with "n fixes to review"; nothing to fix is said in the dialog.
- Disabled with the reason shown (`fixBlocker`): no transcript; no script and no glossary entry; only an unusable
  source chosen; no speech model installed (the dry run still counts); read-only project; no engine. Every route and
  job code is said in words (`fixErrorText`): `E_NOT_FOUND`, `E_NO_SOURCE`, `E_NO_TRANSCRIPT`, `E_INVALID_PARAM`,
  `E_NO_SPEECH_MODEL`, `E_LIMIT`, cancellation, network, else the engine's message with its code.

### Review rows (SC-082)

- The Review panel's own rows, keys, decisions, stale handling and "Not selected" marker; for
  `transcript-correction` the row's text is the diff (`FixDiff`: up to 3 context words · ~~before~~ → **after** · up to
  3 words) and its second line the category (Name / English word / Short word / Word), the confidence label and the
  rule with Δ_tok ("High confidence · Audio check · Δ +3.4 per token"). Rows are timed where the sequence plays the
  words (`fixFrame`: the media time through the first audio clip that holds it), else "recording 0:12.4".
- Confidence bands (**assumption, not measured**): Δ_tok ≥ 0 High (the audio prefers the script reading), ≥ −1.5 (the
  Standard fix margin, SC-034) Medium, lower Low; no Δ (joins, glossary spellings) "No audio check". The groups
  themselves follow the strictness the run used.
- ▶ / Space / the details' "Play the recording": the SOURCE recording from 1 s before to 1 s after the edit's span,
  streamed from the engine's media URL through one `<audio>` element (a fix may lie outside the sequence); playback
  errors are toasts.
- Group headers have "✓ All" / "· None" (Shift+Enter / Shift+U): accepting a group takes its unselected Maybe items too
  (an explicit choice); Accept all keeps leaving them out (SC-061). The Sound Check bar is not shown for this feature.
- Rejections are remembered by the engine (`scengine` reject listener / accept extension), not by the UI.

### Marks in the transcript (SC-083)

While a `transcript-correction` proposal is under review, the open items (pending, accepted, stale) mark the words
of their edit span — an insertion marks the word after the gap — with a dotted accent underline (instead of the
low-confidence wavy one) and the title "Proposed fix: before → after. Click to review it"; a click selects the item
(`focusItem`) and focuses the Review panel. Rejected and applied items are not marked.

### Patch report (SC-053 / SC-084)

The proposals session slice now returns the accept transaction's per-command `results`; `patchReportOf` sums the
`transcript.replaceWords` results (clips counted once, other commands ignored) into "N fixes applied · M subtitles not
updated: edited by hand" (several reasons: "2 edited by hand, 1 on a locked track"). It is the Apply toast's title
and a bar in the Review panel while that proposal is open, with "Show skipped subtitles" (selects them in their
sequence, opening it; clips in other sequences counted in a notice; deleted ones left out) and ×.

### Manual-edit offers (SC-071 / SC-085)

After a double-click fix or Correct… succeeds, `editOffer` runs `findReplaceAllInSequence` on the document after the
edit (the edited span excluded) and the bar offers "Replace all N" (one transaction of one `transcript.replaceWords`
per transcript, History "Replace All: from → to", one undo step; a refusal such as `E_STALE` is said in the bar) and
"Remember" (`rememberGlossaryEntry {from: [old], to, lang}` with the transcript's base language). Never automatic;
× dismisses it. No bar when the correction is empty, or changes only punctuation, or when there is no other occurrence
and nothing the glossary can hold (same spelling ignoring case). Interpretation (assumption): with no other
occurrence "Remember" alone is still offered — it is what keeps the name right in future transcriptions (G3).

### Transcribe "Names from" (SC-074)

Generate Transcript gains "Names from: Off (default) / Script / Script + glossary". `promptTerms` composes the model's
exports (no new model helper): the script's `word` tokens whose norm is in `parseScript(…).properNorms` or that
`isEnglishWord` accepts (Spanish), without numbers, in the most frequent written form; with the glossary the entries'
`to` for the language (or without one), ranked by script frequency + taught `count`, ties in order of appearance; ≤ 40
terms of ≤ 64 characters, deduplicated by normalised form. The dialog lists the first 8; `requestOptions` sends
`glossary` only when the option is on. For media targets the script is the active sequence's.

### i18n and design

English catalogue regenerated (`pnpm i18n`), Spanish strings in `es.json`, `pnpm i18n:check` clean. Transcript words,
the diff and the offer's words are marked `data-no-i18n`: the document translator used to turn a transcript word that
equals a model name ("One") into its translation ("Uno") — a display bug of the Transcript tab fixed here. Design
tokens only (`check-tokens` ok).

### Validation (build VM, 2026-10-27)

- Tests: `apps/web/test/script-fix-model.test.ts` (blockers, texts, confidence, frames, marks, patch report, offer,
  prompt terms; fast-check properties for marks, results and prompt terms), `script-fix-dialog.test.tsx` (blockers,
  dry-run summary, settings in one undo step, Run → Review, Cancel → `cancelJob`, refusals in words),
  `script-fix-review-rows.test.tsx` (rows, ▶ source window, group decisions, stale row, report with and without
  skipped subtitles, selection, one undo restores transcript and subtitle), `transcript-tab-editing.test.tsx` (the
  first Transcript tab editing test: double-click and Correct… fixes, Replace all N in one step, Remember, no offer,
  dismiss, Script… summary, Fix dialog, marks and click → Review row), `script-fix-commands.test.ts` (commands,
  menus, no shortcut, key conflicts), `speech.test.tsx` (Names from). The whole web suite: 189 files / 1,307 tests passed.
- Dev stack on the VM (engine 47946, vite 5216, appdir `wt-scweb/.stage`, whisper-tiny.en): the LJ fixture
  transcribed, 4 words corrupted, the true text attached through the drawer, Fix Transcript dry run (97 % aligned,
  4 candidates, ≈ 23 s reference estimate) and Run → 4 fixes (all High, Δ +3.2…+9.2) in Review, marks in the
  transcript and the jump, Apply → "Fix transcript: 4 fixes", subtitles patched, report shown; Replace all / Remember;
  Names from carrying the glossary; the same in Spanish with a skipped-subtitle report and "Show skipped subtitles"
  selecting 3 clips.
- e2e `e2e/script-fix.spec.ts` (SC-104): the LJ fixture imported and transcribed by whisper-tiny.en (provisioned by
  `scripts/e2e-prepare.mjs` → `apps/engine/scripts/provision-speech-models.ts`, linked into the throwaway appdir by
  `e2e/serve.mjs`; the spec fails when the model is not installed), 3 words corrupted (`transcript.create`), Pixel Pop
  subtitles generated, Script… → Fix Transcript (dry run, Run) → Review rows → Accept all → Apply: History "Fix
  transcript: N fixes", the words restored, the subtitle clip patched in place (same id, style and effects), the
  report shown; Ctrl+Z restores transcript and subtitle. Passed with `pnpm e2e e2e/script-fix.spec.ts` and
  `JASPER_FFMPEG_LGPL_ONLY=1` on the build VM (≈ 42 s for the test).

### Limitations

- ▶ streams the original file: a codec the browser cannot decode is reported, not converted (no proxy used).
- Right after Apply the rows show "Stale" for about a second until the engine's applied state arrives (the generic
  proposals preview revalidates against the new document first; not specific to this feature).
- The Apply toast shows its first two actions; "Show skipped subtitles" stays in the Review bar.
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

### Results with unpacked windows (Standard; CPU and WebGPU give identical decisions)

The first harness run, with unpacked windows; the shipped default is muted packing, measured against these numbers
in "Muted packed windows" below.


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

### Muted packed windows (the shipped default)

Unpacked windows met every accuracy target but cost 23.4–24.7 s per speech minute on the VM's long benchmark (SC-037:
≤ 20 s). The default is now packed windows (≤ 28 s, one encoder pass) whose gaps are muted: everything between the
padded ranges of the packed stretches is zeroed before the log-mel of that window (`ScoreWindow.mute` → the SC-092
request's optional `mute` → the worker), so the decoder can't hear speech the transcript doesn't hold, and the frames
stay where they are. Same harness, same conditions (CPU, 8 threads, Standard):

| SC-105 target | Unpacked (previous default) | Muted packing (default) | Met |
|---|---|---|---|
| Corrupted-script false fixes ≤ 0.5 % | 1 / 558 (0.18 %) | 1 / 558 (0.18 %): phonetic 1 / 194, same category 0 / 174, random 0 / 190 | yes |
| 0 audio fixes in the cleanup's off-script / head-tail / hallucination regions | 0 (+ the head-tail join) | 0 (hallucination: 1 Maybe, 1 kept; + the same head-tail join) | yes |
| Recognition errors fixed ≥ 70 % | 38 / 52 (73 %) | 38 / 52 (73 %); 5 Maybe, 9 kept | yes |
| … with 0 real deviations fixed | 0 / 55 | 0 / 55 (unclear: 15 / 56 fixed) | yes |
| Injected errors restored ≥ 50 % | 245 / 430 (57 %) | 247 / 430 (57 %; 257 with a candidate) | yes |
| Proper-noun splits / glues ≥ 50 % | 5 / 10 | 5 / 10 (spike list 3 / 4) | yes (at the limit) |
| Natural fixes per speech minute | 2.49 | 2.44 (190: 91 audio, 39 spelling, 9 `del`, 51 joins); Maybe 0.95 | — |
| Encoder passes (natural run) | 249 | 204 (2.6 per speech minute; 294 muted ranges) | — |
| Mac CPU cost per speech minute | 4.27 s (encoder 3.95) | 3.68 s: encoder 3.19 (1.22 s per pass), decoder 0.23, rest 0.25, alignment 0.005; + load 0.26, decode 0.92 per job | measured |

- The one false fix differs: muted packing fixes a corrupted function word that replaces a hallucinated "Gracias." and
  the next word (a 2 → 1 `sub`, Δ_tok −0.84) instead of the unpacked run's corrupted English word (spelling rule,
  −4.91). The corrupted-word tail is closer to the margin: phonetic neighbours p50 / p99 / max −10.08 / −2.20 / −0.84
  (unpacked −10.29 / −2.34 / −1.80); adjudicated A p50 −1.75, R p50 −5.54; paired with the spike's mlx fp16 on the same
  corrupted word, median −0.14 (p10 −2.20, p90 +1.60).
- Sweep: Careful 1 false fix, 31 / 52 A, 0 R + N; Generous 2 false fixes, 41 / 52 A, 0 R + N.
- Mac conditions: the natural (cost) run on AC power with Low Power Mode off, load average 2.8–3.1 before the run;
  the Mac went onto battery with Low Power Mode on during the injected-error run (accuracy unaffected: the same
  computation), so the muted WebGPU run was stopped and not measured. Basis for an estimate [≈]: the unmuted packed
  WebGPU run (same 204 passes) took 2.40 s per speech minute; muting only recomputes the frames at the range edges.

**VM long benchmark** (`apps/engine/test/transcript-fix.bench.test.ts`, `TRANSCRIPT_FIX_BENCH=1`, turbo fp32, CPU,
8 speech threads, 10.631 speech minutes, 66 candidates; three full jobs each, median; bench lock held for both, run
back to back on the same VM; load average before → after each run from the bench's own log):

| Windows | Job per speech minute | Encoder (passes) | Decoder | Runs (s) | Load average 1 min | Decisions |
|---|---|---|---|---|---|---|
| Muted packing (default) | **13.62 s** (target ≤ 20 s: met) | 9.85 s (22) | 1.37 s | 138.7 / 144.8 / 144.8 | 2.3 → 7.2 | 22 fix, 11 Maybe, 33 keep |
| Unpacked (366b4885) | 23.38 s (not met) | 20.38 s (48) | 1.30 s | 245.1 / 253.1 / 248.6 | 5.6 → 7.4 | the same 66 decisions (Δ_tok within 0.85) |

The load rises from the job itself (8 threads) and other agents' work; the VM was shared, not quiet.

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
2. **Windows are not packed by default** (superseded by muted packing, below). The two real deviations, the hallucination-region fix and both corrupted
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

4. **Packed windows with muted gaps (the default now).** Unpacked windows missed SC-037 on the VM (23.4 s per speech
   minute); packing again with the gaps muted keeps every accuracy target (table above) at 13.6 s. `pack: false`
   (unpacked) and `muteGaps: false` (the old unmuted packing) stay options.
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
- Muted gaps protect against speech the transcript missed in the gaps between stretches, not inside a stretch (gaps
  under 1 s are heard, as in the spike's own windows). The muted run's single false fix sits closer to the margin than
  the unpacked one's.
- The muted WebGPU cost was not measured (the Mac left AC power during the run).
- Audio came from 16 kHz extractions, not the original media containers; no voice analysis was available to the
  re-timing.
- Rerun: harness in the private research folder `sccalib` (`mkinputs.py`, `sccalib.ts`, `run.sh`, `scfinal.py`).
