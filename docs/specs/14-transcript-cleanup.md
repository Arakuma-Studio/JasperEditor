# Spec 14: Transcript cleanup — "probably wrong" detector and tight auto-cut

Status: specified 2026-10-25; implementation tracked in [`docs/ledgers/premiere-workflow.md`](../ledgers/premiere-workflow.md).
Owner wp-note: `docs/wp-notes/transcript-cleanup.md` (created by the implementation). This spec wins over older specs
for what it covers; [`ARCHITECTURE.md`](../ARCHITECTURE.md) and [`AGENTS.md`](../../AGENTS.md) win over this spec.
Related: [spec 13](13-auto-subtitles.md) (subtitles, shared cut services), [spec 15](15-edit-automation.md) (editing
automation, proposals), [spec 16](16-speech-gpu-models.md) (Whisper runtime and models).

## 0. Background

The user is a Spanish-language, fast-paced YouTuber (gamedev, "MrBeast-style" retention editing). Other tools —
including JasperEditor's current Remove Pauses / Remove Fillers — leave empty sound at the cuts and miss retakes.

Evidence (measured on the user's 31 Premiere projects and their raw OBS recordings; private research
`.prproj-analysis/research/edits` and `research/cutsurvey`; numbers are reproducible from the scripts there):

- The user records long OBS sessions, jump-cuts picture and voice together in Premiere, then polishes the voice in an
  external DAW. Ground truth = the picture edit (17 projects frame-exact) or export-to-raw alignment.
- Style: 17–22 cuts per minute of final audio; kept pieces median 2.3 s (shorts) / 3.0 s (long); **no pause longer
  than ≈100 ms survives inside kept audio; joins leave 0 ms of silence (median; p90 37–60 ms); out point inside the
  word decay ≈ floor + 21–25 dB (drops the last 120–140 ms of tail); in point at the onset (0 ms, p90 10 ms); breaths
  never kept; no crossfades.**
- Removed time is mostly silence (76–87 %); removed words are mostly **retakes** (49–56 %), the **last** take kept
  79 % (shorts) / 97 % (long); then off-script chatter (21 % / 7 %), dropped script lines (9 % / 17 %), fragments and
  false starts (≈10 %); true fillers (eh/em/mmm) are rare (and Whisper drops them).
- Current JasperEditor tools with defaults: output 1.9–2.0× the user's length, 7.0–7.5 s non-speech per minute (user
  0.3–0.8 s), 200 ms of air at every join, 0 % of the user's removed words removed; English-only filler list.
- A prototype detector + level-referenced edge placement ("fast" preset) reproduced the user's cuts: removed-word
  precision 0.90–0.91, recall 0.78–0.79; removed-time precision 0.98–0.99, recall 0.95–0.98; 72 % of the user's edit
  points within 50 ms, 83–84 % within 150 ms; output 1.08–1.09× the user's length with the same dead air.
- Competitor survey: transcript-only silence detection is the most complained-about failure (dead air, clipped word
  edges); waveform tools use −30…−45 dBFS, 0.3–0.75 s minimum silence, asymmetric padding; keep-last-take is the
  universal retake default; no tool ships Spanish fillers.

## 1. Goals

- G1 Detect and flag "probably wrong" speech with typed, explained findings: pauses/dead air, breaths, fillers
  (language-aware, Spanish first-class), restarts, false starts, retakes (with take groups), off-script talk (when a
  script is attached), head/tail chatter, ASR suspects (hallucinations, low confidence, untranscribed voice).
- G2 Auto-cut them with edit points placed from the **audio level**, not word timestamps, so cuts leave no dead air
  and never clip word onsets or tails — reproducing this user's style with the "Fast" preset and offering calmer
  presets for other users; every number is configurable.
- G3 One review experience (transcript strike-through + findings list + retake groups + live stats) and one undo step
  per apply; equally drivable by AI agents through MCP with structured findings and dry-run statistics.
- G4 Keep picture and sound in sync: cuts act on the speech clip and its linked picture and follow sync-lock rules.

Non-goals: generative audio repair; voice processing chains (EQ/de-ess) — the existing audio effects cover those;
LLM-based content judgement (agents may layer it on the MCP tools).

## 2. Requirements

### 2.1 Analysis signals (engine)
- TC-001 **Voice analysis job** (`JOB_KINDS` entry `voice-analysis`; engine, cancellable, progress, errors propagate):
  for a media file + audio stream, compute 10 ms frames: RMS dBFS (25 ms window); noise floor = 10th percentile and
  speech level = 95th percentile per file (and per 60 s window for drifting rooms); voicing = normalised
  autocorrelation peak 70–400 Hz; spectral flatness 0.3–6 kHz. Frame classes: **speech** (level > floor + max(6 dB,
  30 % of floor→speech range) and voiced, or ≥ 10 dB above that threshold), **breath-like** (above floor + 5 dB,
  voicing < 0.5, flatness > 0.15, runs 120–900 ms), **silence** (rest). Result cached as a media derivative (keyed by
  file fingerprint + stream + analysis version), zod-validated when read, size-capped (≈ 1.4 MB/hour compact binary or
  JSON arrays of uint8 levels — choose and document).
- TC-002 Reuse the speech worker's existing VAD/floor code where it overlaps (`apps/engine/src/speech/core/vad.ts`);
  no parallel implementation of the same thresholds.
- TC-003 Transcription improvements needed for cleanup (in the speech worker; coordinated with spec 16): language-aware
  **verbatim prompt** support (requires tokenizer *encode* for the initial prompt; Spanish default prompt
  `Eh... em, bueno, o sea, este... mmm, ¿vale? Ah, eh, pues...`; English equivalent), `condition_on_previous_text =
  false` option, keep per-segment `avgLogprob`, `noSpeechProb`, `compressionRatio` in the stored transcript (optional
  fields), and the **hallucination guard**: drop runs of ≥ 4 identical tokens; drop words whose frames are < 20 %
  speech/breath; flag known hallucination phrases ("Subtítulos realizados por la comunidad de Amara.org", "Gracias por
  ver el video", "Gracias.", English "Thanks for watching") when they sit over non-speech.
- TC-004 Word bounds refinement: after transcription, snap each word's start/end to the speech frames (extend into
  speech, tighten over silence) as the engine already does (`tightenWords`/`extendWordsIntoSpeech`), using TC-001 data.

### 2.2 Detector (pure, `packages/project/src/cleanup/`)
- TC-010 Input: words (text, start, end, probability, speaker), segment scores, frame classes/levels (TC-001), optional
  script text, language, settings. Output: `CleanupFinding[]` `{id, kind, range:{start,end} (media time, flicks),
  words:[i0,i1], confidence 0–1, reason (human-readable, localisable key + params), suggested: 'remove'|'review'|
  'keep', group?, fingerprint}` plus `RetakeGroup[]` `{id, takes:[{range, words, text, scriptLine?, meanProb,
  complete}], chosen}`. Deterministic, no DOM/Node APIs, fast (≤ 200 ms for 1 h of speech on the build VM; measure).
- TC-011 Rules and default thresholds (from the measured user data; all settings):
  | Rule | Definition |
  |---|---|
  | restart | an n-gram the speaker already said shortly before: a 3-gram within 40 words, or a 2-gram containing a content word (≥ 4 letters, not a stop word) within 10 words, both within 60 s → remove from the earlier copy up to the restart point; the earlier copy must lie after the last accepted restart point |
  | retake | speech units split at pauses ≥ 0.6 s; a unit whose content words re-appear ≥ 60 % (LCS ratio) in a later unit within 120 s, and the later unit starts with the same content word (within its first 3 words) → earlier take; group all takes of a line; default keep the **last complete** take |
  | false start | 1–3 words re-said immediately (next unit within 3 s starts with them) |
  | filler (vocalic) | per-language strict list (Spanish: eh, em, emm, ehm, mm, mmm, hmm, mhm, ah, uh, um, e/ee, a/aa; English: um, uh, umm, uhm, erm, er, ah, hmm, mm, mhm) + drawn-out vowels > 0.95 s; high confidence |
  | filler (lexical) | per-language list (Spanish: este, o sea, pues, bueno, vale, tipo, en plan, a ver, es decir, digamos, ¿sabes?, ¿no?, nada, vamos, ok): only when the phrase consists solely of markers between pauses → remove; inside a sentence ("este video", "pero bueno") never; otherwise flag low confidence |
  | repeat/stutter | 1–3 repeated words with gap < 0.3 s or a cut-off word restarting ("jue- juego"); allowlist emphasis/onomatopoeia per language ("no no", "sí sí", "ta ta ta") |
  | off-script | (script attached) phrase (pauses ≥ 0.3 s) with ≥ 3 content tokens of which < 35 % occur in the script vocabulary |
  | head/tail | everything before the first / after the last scripted speech (script attached) or before/after the first/last speech unit of the selection |
  | pause / dead air | any non-speech run longer than `maxGap` inside or between kept speech |
  | breath | breath-like runs adjacent to kept speech (policy setting) |
  | untranscribed voice | speech-class frames ≥ 150 ms with no word → flag "review" (dropped filler, laugh, mumble); never auto-removed |
  | ASR suspect | low confidence (< 0.4), hallucination guard hits, implausible durations (word < 40 ms or > 2.5 s) → review |
  Language: from the transcript language; per-project editable lists (persisted, TC-030).
- TC-012 Script alignment (optional): a script (plain text) can be attached per sequence; sentences are aligned to
  speech units; retake groups get a `scriptLine`; lines never said are reported; when several takes cover a line,
  prefer the last complete one unless an earlier take covers ≥ 20 % more of the line.
- TC-013 Findings carry a stable `fingerprint` (media id + stream + rounded range + text hash) so rejections persist
  across re-runs and stale results are detected after edits.

### 2.3 Cut planning and edge placement (pure)
- TC-020 From accepted findings + kept speech, compute kept ranges in **source time** per speech clip, then map to
  sequence time through the clip's placement (speed 1; refuse with `E_UNSUPPORTED` for time-remapped/reversed clips,
  naming them).
- TC-021 Edge placement (default "level" mode): **out point** = first 10 ms frame after the last kept speech frame whose
  level falls below `floor + outDb` (Fast 20 dB); **in point** = first frame at/after the onset reaching `floor + inDb`
  (Fast 25 dB); optional pads (ms) before/after; alternative reference "speech level − X dB"; "word" mode = word bounds
  ± pads (for files without TC-001 data). Then snap boundaries to frame boundaries of the sequence and, inside a ±10 ms
  window, to the quietest sample region.
- TC-022 Gap policy: non-speech between kept speech longer than `maxGap` is cut down to `keepGap` (Fast: maxGap
  0.12 s, keepGap 0; Natural: maxGap 0.45 s, keepGap 0.25 s inside a sentence / 0.5 s between sentences).
- TC-023 Guards: minimum kept piece (Fast 0.25 s, Natural 0.4 s); no cut shorter than 2 frames; drop kept slivers
  < 3 frames; "avoid harsh cuts" — skip a filler cut whose edges can't land below `floor + inDb` within 30 ms and report
  it as skipped.
- TC-024 Join fades: on request ("Fade joins", `joins.fadeMs` 0–30 ms; 0 = hard cuts, the built-in presets' default
  by the user's decision, see wp-notes/transcript-cleanup.md "Join fades of range cuts"), every audio join gets an
  equal-power micro-fade implemented with the existing audio fade/transition model so preview and every export path render it identically (AGENTS §4);
  optional J/L offset in frames (default 0).
- TC-025 Presets (built in, editable copies): **Fast** (measured on this user) and **Natural** (general) with the values
  above plus: breaths before an onset removed (Fast) / kept ≤ 600 ms (Natural); restarts/false starts removed (both);
  retakes keep-last removed (Fast) / grouped for review (Natural); fillers strict+marker phrases (Fast) / strict only
  (Natural); off-script removed (Fast, with script) / flagged (Natural). Expected cuts/min ≈ 17–23 (Fast).
- TC-026 Plan output and dry run: `{keptRanges, removedRanges with reasons, stats: {inputDuration, outputDuration,
  removedByKind, cutsPerMinute, deadAirPerMinute, largestSilenceLeft, joins}}`; dry run never changes the document.

### 2.4 Applying (commands, `packages/project`)
- TC-030 Persisted (schema v10, optional, lenient; invariants + `repairDocument`): `Sequence.cleanup?: {settings (preset
  id + overrides), script?: {name, text ≤ 256 KB}, rejected: fingerprint[] (≤ 20,000), lists?: {fillers, markers,
  allow} per language}`; user-level presets in the user library (like effect presets).
- TC-031 `cleanup.apply {sequenceId, clipIds?, ranges:[{start,end}] (sequence frames or source flicks + clipId), mode:
  'extract'|'lift'|'mute'|'markers', fadeMs, jlFrames}` — ONE command applying any number of ranges (no 5,000-command
  limit issue), right-to-left, O(ranges log clips); cuts the speech clip, its linked partners and clip groups, and
  ripples per sync lock (sync-locked tracks get matching edits; non-sync-locked tracks don't move; locked tracks never
  change); one undo step; refusals with `E_*` codes; returns per-range results. `mute` = volume keys to −∞ over ranges
  with micro-fades; `markers` = range markers only.
- TC-032 Existing `transcript.removePauses` gains `mode: 'transcript'|'level'`, `padBefore/padAfter`, `fadeMs`;
  `transcript.removeFillers` uses the language-aware lists; both keep working for old callers (defaults unchanged for
  API compatibility; UI uses presets).
- TC-033 Undo/redo, refusal and invariant tests for every new command; property tests (fast-check) for planning
  (output never contains a removed range, never splits a word kept by the plan, ranges sorted and disjoint).

### 2.5 UI (`apps/web`)
- TC-040 Text panel ▸ Transcript tab gets **Clean Up** mode (also Sequence ▸ Clean Up Voice…, MCP equivalent):
  preset picker (Fast / Natural / user presets / Custom), settings drawer (all TC-011/021/022/023/024 values with
  units), script attach/paste, scope (sequence / in–out / selected clips), Analyze button (runs TC-001 + detector with
  progress; cancellable).
- TC-041 Review: transcript with red strike-through for to-be-removed words (colour per kind), dotted underline for
  "review" findings, lighter style for lexical fillers; findings list grouped by kind with counts, accept/reject per
  item and per kind, keyboard next/previous/accept/reject (no shortcut conflicts), auto-advance, ±1 s preview; retake
  groups shown side by side with the kept take ticked (click to choose another); timeline overlay colours (cut / kept
  pause / padding) during review.
- TC-042 Live statistics (TC-026) update as decisions change; "Play result" plays a temporary derived timeline with the
  plan applied (session-level snapshot, not saved, not in undo); "Play removed" plays only removed audio.
- TC-043 Apply = one undo step with a History label ("Clean Up Voice: 214 cuts"); rejected fingerprints persist.
- TC-044 Visible errors, never crash; long analyses keep the editor responsive.

### 2.6 MCP (`apps/mcp`) and agents
- TC-050 `analyze_voice {sequenceId | clipId | mediaId, preset?, settings?, script?, language?}` → findings, retake
  groups, kept/removed plan, stats (TC-026), with paging for long results; `plan_cleanup` (dry run with decisions:
  accept/reject by finding id or kind, retake choices); `apply_cleanup` (applies a plan; approvals only where AGENTS
  rules require); `set_cleanup_settings`, `attach_script`; guide resource "Cleaning up speech" with the recommended
  agent policy (accept removes; review retake groups — last complete take unless cut off, low probability or further
  from the script; never cut untranscribed-voice findings blindly; check stats: largest silence, cuts/min).
- TC-051 Strict schemas, annotations (readOnly for analyze/plan), errors as MCP error results.

### 2.7 Performance and scale
- TC-060 1 h of speech: analysis job ≤ 2 min on the build VM CPU (measure), detector ≤ 200 ms, apply of 1,500 ranges
  ≤ 2 s and one undo step; UI review list virtualised.

### 2.8 Validation
- TC-070 Unit + property tests for every rule (Spanish and English fixtures generated from synthetic or openly
  licensed speech — never the user's footage); fuzz the analysis result parser; golden test of the Fast preset
  reproducing a synthetic recording with known retakes/pauses (precision/recall thresholds asserted); preview-vs-export
  audio comparison across joins (micro-fades identical); e2e: Clean Up mode on a generated clip, apply, undo.
- TC-071 Calibration report in the wp-note: rerun the prototype metrics on the user's material on the Mac
  (`.prproj-analysis/research/edits` scripts adapted to call the shipped detector) and record precision/recall/edge
  errors vs the user's cuts (measured, with machine/load).

## 3. Placement
- Pure: `packages/project/src/cleanup/{detector,rules,lists,plan,edges,schema}.ts`; commands in `commands/`.
- Engine: `apps/engine/src/voice/` (analysis job + derivative), speech worker changes in `apps/engine/src/speech/`.
- Web: `apps/web/src/panels/text/cleanup/*`, player derived-preview support in `packages/session`.
- MCP: `apps/mcp/src/tools/cleanup.ts` + guide.
- Docs: wp-note, `docs/gaps.md` / `docs/parity.md` updates with evidence only.
