# Spec 17: Script-guided transcript correction

Status: specified 2026-10-27; implementation tracked in [`docs/ledgers/script-correction.md`](../ledgers/script-correction.md).
Owner wp-note: `docs/wp-notes/script-correction.md` (new). [`ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`AGENTS.md`](../../AGENTS.md) win over this spec. Related: [spec 13](13-auto-subtitles.md) (subtitle text clips),
[spec 14](14-transcript-cleanup.md) (script attachment, cleanup), [spec 16](16-speech-gpu-models.md) (Whisper worker).

## 0. Background (measured 2026-10-27; private research `.prproj-analysis/research/scriptfix`, 16 raw recordings)

The user writes a script for every video, reads it on camera with retakes, ad-libs, paraphrases and off-script
chatter, and does not want to fix transcript or subtitle words one by one. Measured on 78 min of the user's speech
(13,381 words, Whisper large-v3-turbo) aligned to the whole pasted script file:

| Measure | Value |
|---|---|
| Transcript words aligned exactly to the script / off-script | 79 % / 14 % (429 retake jumps) |
| Anchored disagreements per speech minute | 6.3 (proper/brand 0.9, English loanword 0.3, number 0.1, function words 2.9 of which 1.5 extra ASR words, other 2.1) |
| False corrections, corrupted-script test (6 % of script words replaced) | 1 of 558 corrupted words (0 of 240 phonetic neighbours) |
| Accepted in the cleanup's off-script / head-tail / hallucination regions | 0 of 68 |
| Adjudicated sample (text-only labels): recognition errors / real deviations accepted | 40 of 52 (77 %) / 0 of 55 |
| Injected ASR errors restored | 240 of 430 (82 % of those that produced a candidate; splits and glued words 2 of 96) |
| Accepted corrections per speech minute | 1.9 |
| Corrected word bounds vs original | start p50 10 / p90 50 ms, end p50 30 / p90 170 ms |
| Cost, M4 Max (mlx fp16) | ≈ 2.4 s per speech minute (76 % encoder); ≈ 1.4 s with window packing (estimated) |

Method that produced it: word alignment with jumps and an off-script state → candidate disagreements between exact
anchors → each candidate decided against the audio by teacher-forced likelihood of the script reading vs the ASR
reading on the same window → corrected words re-timed by forced cross-attention DTW. A text-only diff would rewrite
real ad-libs ("basado" → "inspirado"); the audio check rejected all of those. A name glossary prompt raised exact
proper nouns from 73 % to 94 % but dropped some real chatter once and possibly inserted a script term once, so it is
optional. Thresholds were tuned on the same 16 items (no held-out set) and with mlx fp16, not the editor's ONNX fp32:
the accuracy harness (SC-105) re-measures them with the editor's own code.

## 1. Goals
- G1 Paste the script once; the editor fixes recognition errors everywhere (transcript, subtitles, caption tracks,
  cleanup, text-based editing, search, Style Check, MCP) without rewriting words the user really said.
- G2 Every fix is reviewable, explained (before → after, why) and one undo step; nothing is lost (subtitle styling,
  line breaks, speakers, timing of untouched words).
- G3 Names stay right in future transcriptions (glossaries) and manual fixes are never needed twice.
- G4 Correct on every machine (CPU, CUDA, WebGPU) with the existing fallbacks, bounded memory and visible progress.

## 2. Requirements

### 2.1 Script
- SC-001 One script per sequence, shared with spec 14: `Sequence.cleanup.script {name, text}` (≤ 256 KB) stays the
  storage (no schema change); UI and MCP call it "Script". Attach from the Transcript tab (paste, load `.txt` / `.md`,
  replace, detach) with the existing `ScriptDrawer`, from Clean Up as today, and MCP `attach_script`.
- SC-002 Script parsing (pure, `packages/project/src/script-fix/`): whitespace tokens keeping line numbers;
  `paren` tokens = inside `(...)` (spoken asides and stage directions alike); `heading` = a line of ≤ 8 words matching
  `^(short|guion short|video largo|largo|intro|outro)\b` (case/accents ignored) or ending in `:`; `section` index
  increments at headings; `&` reads as "y" (es) / "and" (en). The drawer shows sections found and how many
  directions/headings are skipped.

### 2.2 Alignment (pure, `packages/project/src/script-fix/align.ts`)
- SC-010 Normalisation: transcript and script words through `cleanupNorm` (lower case, accents stripped, ñ→n, keep
  [a-z0-9]); words normalising to nothing are skipped but keep their index.
- SC-011 Numbers: digits ↔ number words, Spanish and English, 0–999,999 (`24` = "veinticuatro", `3d` = "tresd",
  "un"/"una"/"one" = 1) count as exact matches.
- SC-012 Phonetic key and similarity (`psim`), language `es` (English digraphs included): digits → words; sh→X, th→t,
  ph→f, ee→i, oo→u, ck→k, -tion→-sion; ch→X, ll→y, rr→r; qu(e/i)→k, gu(e/i)→g, g(e/i)→j, c(e/i)→s, other c→k; z→s,
  v→b, w→u, x→ks, h dropped; y not before a vowel → i; doubled letters collapsed. psim = 1 − weighted Levenshtein /
  max key length (equal keys 0.95, equal strings 1.0) with the substitution costs j/y 0.3, i/y 0.3, i/e 0.5, o/u 0.5,
  d/t 0.5, g/k 0.5, b/p 0.5, n/m 0.5, s/X 0.5, j/X 0.4, y/X 0.4, r/l 0.6, k/j 0.6, f/j 0.6 and indel costs s 0.5,
  d 0.5, n 0.6, e/i/u 0.6, a/o/r 0.7 (others 1). Merges/splits compare concatenations. Language `en`: the same key
  without the Spanish c/g/j/ll rules; other languages: accent-stripped Levenshtein only (documented).
- SC-013 Viterbi alignment over transcript tokens with states aligned / transcript-insertion / OFF (off-script).
  Cell scores: exact content word (not a stop word, ≥ 3 letters) +3, exact function word +1.5, otherwise
  max(−1.5, 4·psim − 3); merge cells 2:1, 3:1, 1:2, 1:3 when psim of the concatenations ≥ 0.7, scoring
  (4·psim − 3)·(a+b)/2 (3·(a+b)/2 when exact). Moves: diagonal; skip k ≤ 8 script tokens at 0.5 + 0.5 × non-direction
  tokens skipped (paren/heading tokens free); insertion −1; jump anywhere (retake / dropped line) −4; enter and leave
  OFF −2 each, −0.4 per OFF word; free start and end. All weights live in one exported `ALIGN_DEFAULTS` object.
- SC-014 Each media transcript used by the sequence is aligned separately against the whole script (scope SC-063).
- SC-015 Bounded cost: a 2 h transcript (≈ 20,000 words) against a 6,000-word script completes in ≤ 5 s on the build
  VM and ≤ 300 MB extra memory (banding around anchors plus a jump table; exact-match index for anchors); inputs over
  the bounds (> 200,000 transcript words, > 60,000 script tokens) are refused with `E_LIMIT`. Deterministic.
- SC-016 Alignment report: per media share aligned / off-script, retake jumps, unused script lines (shown in the
  dialog and returned by MCP).

### 2.3 Candidates (pure)
- SC-020 A candidate = a maximal run of non-exact steps between exact cells, without a jump or OFF inside, with an
  anchor on each side (≥ 2 consecutive exact cells or 1 exact content word) and ≤ 4 transcript and ≤ 4 script words.
- SC-021 Kinds: `sub` (n:m replacement), `merge` (merge cell), `del` (script-only words → inserting them), `join`
  (exact concatenation with a different split, SC-024), `glossary` (SC-073). `ins` (transcript-only words) is never
  offered: an ad-lib cannot be told from an ASR insertion.
- SC-022 Never offered: numbers and unit formats; script words with a letter repeated ≥ 3 times (stylised spelling);
  regions touching heading or paren tokens; regions made only of skipped tokens.
- SC-023 Categories (for review and rules): `proper` (script word capitalised mid-sentence or a known brand-like token
  — mixed case, digits inside — or present in the personal glossary), `english` (English word list + digraph
  heuristics; list in the module), `function` (stop words of the language), `other`.
- SC-024 Spelling joins: an exact concatenation match whose split differs ("Play Store" ↔ "Playstore") becomes a
  `join` candidate only when the script side is `proper`; it is decided without audio (script spelling wins) and
  grouped as Spelling.
- SC-025 Mixed regions: a region combining a `proper`/`english` part with other words is split at merge boundaries;
  the non-proper part is decided on its own with the audio margin (measured false correction otherwise).
- SC-026 Each candidate carries a stable fingerprint (media, normalised ASR words, normalised script words, ± 2
  context words) used for rejections (SC-055) and staleness.

### 2.4 Audio verification
- SC-030 Windows: the transcript is split at gaps ≥ 1 s; windows are packed to ≤ 28 s of audio and split at their
  largest gap when longer; each candidate's window is padded 0.25 s before and 0.35 s after its words (≤ half the gap
  to the neighbours). Only windows containing candidates are decoded; one encoder pass per window per job.
- SC-031 Readings: reading 0 = the window's ASR words; reading k = the same words with candidate k replaced by its
  script words (script spelling; script casing only for `proper`; ASR punctuation: a region's leading ¿¡ and trailing
  .,?! are carried; first word capitalised when the ASR one was). Several candidates in one window are scored
  independently against reading 0.
- SC-032 Scoring (worker): tokens `[sot, lang, transcribe, notimestamps] + Σ encode(' ' + word) + [eot]`, one
  uncached decoder pass per reading (batching allowed), no prompt; LL = Σ full-vocabulary log-softmax of every text
  token and `eot`; per-word token counts and log-probabilities returned; refusal code when the tokenizer cannot encode.
- SC-033 Δ = LL_k − LL_0; Δ_tok = Δ / max(script-region tokens, ASR-region tokens, 1).
- SC-034 Decision rules with the strictness presets (default Standard):

  | Rule | Careful | Standard | Generous |
  |---|---|---|---|
  | `sub` / `merge` / `glossary` fix when Δ_tok ≥ | −1.0 | −1.5 | −2.0 |
  | spelling rule: script side `proper` or `english`, psim ≥ 0.8, fix when Δ_tok ≥ | −4 | −5 | −5 |
  | `del` fix when Δ_tok ≥ | 0 | 0 | 0 |
  | Maybe (offered unselected) when Δ_tok ≥ | −3 | −4 | −4 |

  Everything else: keep the transcript (shown only in the dialog counts and the MCP report).
- SC-035 Devices: the existing speech device plan (encoder on the best GPU, decoder calibration, per-session CPU
  fallback, GPU fault → job retried once on CPU with the reason recorded); the job result names device and fallback.
- SC-036 Cancellation within ≤ 1 s between windows; worker failure → job error (AGENTS §0); progress per window.
- SC-037 Cost targets (measured, recorded in the wp-note with machine and load): build VM CPU ≤ 20 s per speech
  minute; Mac and NVIDIA figures measured when available (Mac via the harness SC-105).

### 2.5 Re-timing
- SC-040 Fixed words take start/end from forced cross-attention DTW of the accepted reading (the worker's existing
  alignment heads and filters), then `refineWords` VAD tightening, clamped into [previous word end, next word start].
- SC-041 Words outside the fixed region keep their times exactly. `breakBefore` of the first replaced word and the
  speaker of the region are kept; confidence of fixed words = the forced mean token probability.
- SC-042 `join` and personal-glossary spelling fixes without audio keep the region's start/end and split it by
  character count (like `transcript.editText`).

### 2.6 Applying fixes
- SC-050 New command `transcript.replaceWords {transcriptId, edits: [{start, end, expect, words}], subtitles?:
  'patch' | 'none' = 'patch', captionTracks?: 'patch' | 'none' = 'patch'}` (`packages/project`): each edit names the
  media-time span `[start, end)` of the old words and their exact texts `expect`; `words` = the new words
  `{text, start, end, confidence}`. Index-free, so many edits compose in one transaction. Refusals: `E_NOT_FOUND`
  (transcript), new code `E_STALE` (the words in the span no longer equal `expect`), `E_INVALID_PARAM` (overlapping
  edits, words outside the span, unsorted). Undo/redo restore everything; invariants INV-012 hold.
- SC-051 Subtitle text clips (spec 13) of every caption group whose words came from that transcript are patched in
  place in the same command: words located by time overlap and old normalised text, new text passed through the
  group's text transforms, spliced into the clip text keeping styled runs, paragraphs and manual line breaks; lines
  re-broken with the group's rules only when a line now breaks them; `caption.words` and text set together. A clip
  whose text no longer contains the old words (hand-edited), or with Source Text keyframes holding copies of the old
  text, is left unchanged and reported (`skipped: [{clipId, reason}]`). Template effects, linked styles and
  keyframes stay.
- SC-052 Older caption-track clips whose words came from the transcript are patched the same way (their private
  word copies), with the same skip rule.
- SC-053 The command's patch report is available before applying (pure `planReplaceWords` used by the dry run, the
  review and MCP) and shown after accepting ("142 fixes applied · 3 subtitles not updated: edited by hand" with a list
  that selects each clip).
- SC-054 Downstream: cleanup analyses and reviews go stale through the existing transcript-change detection (no new
  code, but a test); fixed words' confidence replaces the ASR one; transcript `segments` are unchanged.
- SC-055 Rejections persist per sequence: `Sequence.scriptFix?: {rejected?: string[] (fingerprints, ≤ 10,000),
  settings?: {strictness, sources, scope}}` — a new optional, leniently read Sequence field (older v10 builds keep
  unknown Sequence keys on save, so no schema bump), with invariant, `repairDocument` handling (drop malformed, cap)
  and a row in `docs/project-files.md`. Rejected fingerprints are not offered again unless "Show rejected" is on.

### 2.7 Proposal
- SC-060 New proposal feature `transcript-correction` ("Transcript fixes", noun "1 fix" / "{0} fixes"), Project
  Settings agent policy (default on: agents may apply the Fix and Spelling groups; Maybe items never auto-applied),
  groups `fix` ("Fixes"), `spelling` ("Spelling"), `maybe` ("Maybe"). The unused "Transcript fixes" group of
  `transcript-cleanup` is removed.
- SC-061 One proposal item per candidate: commands `[transcript.replaceWords]`; meta `{group, kind, category, asr,
  script, deltaTok, rule, mediaId, start, end, contextBefore, contextAfter, fingerprint}`. Maybe items start
  unselected: the proposals framework gains a per-item default selection (`selected: false`) honoured by the Review,
  accept (only selected items unless ids are given) and MCP, with tests.
- SC-062 Staleness: an item whose `expect` no longer matches is stale (dry run through `planReplaceWords`); refresh
  re-runs alignment and verification for the affected media only; accepting applies all selected items in one
  transaction (one History entry "Fix transcript: N fixes").
- SC-063 Scope: Whole recordings (every media transcript referenced by the sequence's audio clips; default) / Only
  what the sequence uses (words inside the sequence's clip ranges) / In–Out range.

### 2.8 Glossaries
- SC-070 Personal glossary (user level, `<appdir>/speech/glossary.json`): `{format: "jasper-speech-glossary",
  version: 1, revision, entries: [{id, from: string[], to, lang?, count, createdAt, updatedAt}]}`, ≤ 2,000 entries,
  zod-validated, atomic writes, corrupt file renamed aside with a reported repair, newer version read-only, change
  event; routes and engine-client methods.
- SC-071 Learning: after a manual word edit in the Transcript tab (`editWord`, Correct…) the editor offers
  "Replace all N" (the same ASR spelling elsewhere in the sequence's transcripts → one `transcript.replaceWords`
  transaction) and "Remember" (adds/updates a glossary entry). Never automatic.
- SC-072 Preferences ▸ Transcription ▸ Glossary: list, search, edit, delete (with undo-free confirmation), import/export
  JSON.
- SC-073 Glossary candidates: entries whose `from` spelling appears in the transcript become `glossary` candidates,
  verified with the audio like `sub` (spelling rule applies to `proper` targets); offered by Fix Transcript when the
  "Personal glossary" source is on (default on), also without a script.
- SC-074 Glossary prompting (optional, default off): Transcribe gains "Names from: Off / Script / Script + glossary";
  ≤ 40 proper/English terms (script spelling, most frequent first) carried into every window's prompt after the
  verbatim prompt, within the 223-token cap; part of the transcription dedupe key; MCP `transcribe {glossary}`.
- SC-075 Prompt guard: when a carried glossary term repeats ≥ 3 times within 10 s, that window is re-decoded without
  the glossary and the unprompted text is kept if it differs; counts reported in the job result.

### 2.9 UI (`apps/web`)
- SC-080 Transcript tab toolbar: "Script…" (drawer, SC-001/002) and "Fix Transcript…"; also Text ▸ Fix Transcript…
  and Sequence ▸ Fix Transcript from Script…; keymap entry without a default shortcut (no conflicts).
- SC-081 Fix dialog: sources (Script, Personal glossary), scope (SC-063), strictness (SC-034), "Show rejected";
  dry run summary (aligned share, off-script share, candidates by group/category, estimated time on this machine),
  Run with progress and Cancel; disabled with a reason when no transcript, no script and no glossary, or no speech
  model is installed.
- SC-082 Review: the proposal opens in the Review panel with text-diff rows (context · ~~before~~ → after ·
  category · confidence label from Δ_tok), play ±1 s of the source audio, select/deselect per item and per group,
  Accept / Reject; Maybe rows unselected; stale rows marked.
- SC-083 While a fix proposal is open, the Transcript tab marks proposed words (dotted underline, hover shows
  before/after); clicking jumps to the Review row.
- SC-084 After accepting: the report of SC-053 as a notice with "Show skipped subtitles".
- SC-085 Manual-edit offers (SC-071) inline after an edit; Preferences glossary page (SC-072); Transcribe option
  (SC-074).
- SC-086 English + Spanish strings (`pnpm i18n`, `es.json`, `pnpm i18n:check`); design tokens; failures shown, never a
  blank panel.

### 2.10 Engine, API, MCP
- SC-090 Job kind `transcript-fix` (`packages/api` `JOB_KINDS`): alignment + candidates (pure module) → speech scoring
  (SC-032 via a `jasper-speech score` worker subcommand) → decisions → proposal (or dry-run report). Route
  `POST /api/projects/:pid/sequences/:sid/transcript-fix {sources, scope, strictness, showRejected, mode: 'propose' |
  'dryRun', device?}` with zod; result `{proposalId?, report: {perMedia, candidates, decisions, skipped, device,
  fallback?, timings}}`; typed engine-client methods; glossary routes (SC-070).
- SC-091 MCP: `fix_transcript {sequenceId, sources?, scope?, strictness?, mode}` (progress, cancellation, strict
  schema, annotations); `list_glossary`, `save_glossary_entry`, `remove_glossary_entry` (destructive → user approval);
  `transcribe {glossary}`; `attach_script` description says the script serves cleanup and fixing; guide resource
  "Fixing transcripts from a script" (attach script → fix_transcript → review/accept → subtitles → cleanup) and the
  automation guide's workflow updated.
- SC-092 Speech service API (engine-internal): `score(req, signal)` with `req = {mediaId, language, model?, device?,
  windows: [{id, start, end (media flicks), readings: [{id, words: string[]}]}]}` → `{device, model, fallback?,
  windows: [{id, readings: [{id, logprob, tokens, words: [{text, tokens, logprob, probability, start, end}]}]}]}`.

### 2.11 Validation
- SC-100 Property/fuzz tests (fast-check): parser and aligner never throw on arbitrary text, are deterministic, stay
  within SC-015 bounds, produce candidates only between anchors, never offer `ins` or numbers; psim symmetric in [0, 1].
- SC-101 Golden tests on invented Spanish and English cases covering every rule (names, merges, joins, del, retakes,
  off-script, directions, headings, `&`, numbers, stylised spellings, mixed regions) — no user data in the repo.
- SC-102 Command tests: `transcript.replaceWords` undo/redo, every refusal, invariants, multi-edit composition;
  subtitle and caption-track patch (style, runs, line breaks, highlight, skipped clips, Source Text keyframes).
- SC-103 Worker tests with the fake ORT (scoring math incl. eot, per-word tokens, batching, refusals, fallback) and a
  real-model test (gated like the existing speech e2e) on `fixtures/speech/lj-composite.flac`: transcript corrupted
  with known confusions → restored with times within 100 ms of the ground truth; script corrupted → nothing applied.
  Margin re-check (ONNX fp32 vs the spike's mlx fp16) recorded in the wp-note.
- SC-104 Engine, MCP and web tests; e2e `e2e/script-fix.spec.ts`: Script… → Fix Transcript → Review → accept →
  transcript and a styled subtitle updated in place → one undo restores both (with a real speech model provisioned by
  the e2e preparation, pinned and sha256-verified; a missing model fails, never passes).
- SC-105 Accuracy harness on the user's Mac with the editor's own code (TS aligner + ONNX scorer, private data stays
  on the Mac, aggregates only in the wp-note): corrupted-script false fixes ≤ 0.5 % of corrupted words; 0 fixes in the
  cleanup's off-script / head-tail / hallucination regions; adjudicated recognition errors fixed ≥ 70 % with 0 real
  deviations fixed; injected errors restored ≥ 50 % overall and ≥ 50 % of proper-noun splits/glues; cost per speech
  minute on the Mac (CPU and WebGPU). Thresholds may be re-tuned only with the numbers recorded before and after.
- SC-106 Docs: wp-note (algorithm, citations, measurements, limitations), `docs/gaps.md`, `docs/project-files.md` row,
  README, MCP docs.
