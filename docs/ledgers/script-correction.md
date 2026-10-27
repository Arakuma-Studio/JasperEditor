# Ledger: script-guided transcript correction

Started 2026-10-27. Private details (machines, agent ids, item names) live in `.prproj-analysis/LEDGER-private.md`.

## 1. What the user asked (2026-10-27)
- Transcription is never perfect and the user doesn't want to fix subtitles or transcript words one by one. They want to
  give the editor the whole written script of a video and have it match the transcript and correct "almost any error
  in all the features".
- Process: a measurement spike first, then a spec, then implement everything 100 % complete and correct with parallel
  subagents in separate worktrees (normal subagents, no workflows), committing progress, merging to `main` when done.
  No separate implementation plan or extra documents beyond the spec.

## 2. Approach agreed before the spike (from the design discussion)
- Align script ↔ transcript word by word (local alignment, Spanish-aware phonetic similarity, unspoken script text such
  as stage directions and headings skipped, retakes allowed).
- Decide each disagreement against the audio: the recogniser scores the script reading and the transcript reading on
  the same audio; the script wins only when it explains the audio at least as well (ad-libs and paraphrases stay).
- Re-time corrected words from the same forced pass (cross-attention DTW).
- Corrections are a reviewable proposal (one undo step, agent policy); accepted fixes update the transcript and flow to
  subtitles (patched in place, keeping style), cleanup, text-based editing, search, Style Check and MCP.
- Extras: proper-noun glossary as a Whisper prompt; a personal glossary learned from manual fixes ("replace
  everywhere").

## 3. Task board
- ✅ Build/test VM rented and provisioned (Hetzner cpx51, shared vCPU).
- ✅ Spike on the user's Mac (16 raw recordings, 78 min of speech; figures in spec 17 §0): 6.3 disagreements per
  speech minute; with the audio check 1 false fix per 558 corrupted script words, 0 fixes in off-script / head-tail /
  hallucination regions, 77 % of adjudicated recognition errors fixed and 0 of 55 real deviations; 1.9 fixes per
  speech minute; ≈ 2.4 s per speech minute on the M4 Max (measured, mlx fp16). Glossary prompt: names 73 → 94 % exact
  but one lost stretch of chatter → optional.
- ✅ Code map of every affected surface + proposed work-package split (private research folder): no schema bump needed
  if the script stays in `Sequence.cleanup.script` and fixes are commands on existing word fields; needs an index-free
  transcript fix command, an in-place subtitle patch, a worker scoring pass (the existing word-alignment pass already
  decodes a given text once), a new proposal feature, and the UI never sends a Whisper prompt today.
- ✅ Spec 17 (`docs/specs/17-script-correction.md`, a58b3157).
- Implementation (worktrees `.claude/worktrees/sc-<name>`, branches `feat/sc-<name>`, integration branch
  `feat/script-correction` off `main` a58b3157):

| WP | Scope | Depends on | State |
|---|---|---|---|
| scalign | parser, aligner, candidates, windows, Δ, decisions (`packages/project/src/script-fix/`) | — | ✅ merged (2ac215fc; 2 h transcript vs 6,000-token script aligned in 2.27–2.46 s, +116 MB, measured on the VM under load; prototype parity on invented text) |
| scapply | `transcript.replaceWords`, subtitle + caption-track patch, `planReplaceWords`, `Sequence.scriptFix`, proposal feature + per-item default selection | — | ✅ merged (249e602f; web 1,257 tests, project/session/mcp 335 files; Review groups and "Not selected" checked in the VM dev stack) |
| scscore | worker scoring + forced DTW, `SpeechService.score`, glossary prompt carry + guard | — | ✅ merged (8afeb29e; VM CPU scoring 19.0 s per speech minute ≤ 20 s target, measured; real-model LJ test 10/10 confusions on tiny.en and turbo, word times ≤ 50 ms) |
| scglossary | personal glossary library, routes, client, MCP tools, replace-all finder, Preferences page | — | ✅ merged (2fd86bf9; 518 tests in the touched suites, page exercised in the VM dev stack) |
| scengine | `transcript-fix` job, route, MCP `fix_transcript`, guide | scalign, scapply, scscore | ✅ merged (f40cdebd; real-model LJ test: 10/10 fixes, times ≤ 100 ms, undo exact, corrupted script → 0 fixes; whole job 13.1 s per speech minute on a 10.6-min synthetic input at research density, VM CPU, turbo, load 7.0–7.7, measured — target ≤ 20 s met; 22/22 injected errors fixed, deviations kept; 24cd51d2) |
| scweb | Script drawer, Fix dialog, Review diff rows, Transcript marks, edit offers, Transcribe option | scengine, scglossary | ✅ merged (4bdd7fe3; web 1,307 tests, e2e `script-fix.spec.ts` passes with a full build and LGPL-only FFmpeg; every surface checked in the VM dev stack; confidence bands High ≥ 0 / Medium ≥ −1.5 / Low are an assumption) |
| sccalib | accuracy harness on the Mac with the editor's own code (SC-105) | scalign, scscore | ✅ merged (6e1c2db2; Mac, ONNX fp32 turbo, Standard: false fixes 1/558 corrupted words (0.18 %), 0 audio fixes in off-script/head-tail/hallucination regions (1 no-audio name join in a head-tail slate), recognition errors fixed 38/52 (73 %) with 0/55 real deviations, injected 245/430 (57 %), proper splits/glues 5/10, 2.49 fixes per speech minute; cost 4.27 s CPU / 2.29 s WebGPU per speech minute; CPU = WebGPU decisions; fixed a scoring refusal on a 238-word hallucination loop; windows unpacked by default) |
- ✅ Integration: `origin/main` had no new commits; final gate on b5041f1e (replacement VM): i18n current, fixtures,
  lint, typecheck, build pass; `JASPER_REQUIRE_ORACLES=1 pnpm test`: 9,355 passed, 7 failed — the 7 that also fail on
  `main` on these VMs (5 Jasper Synth pinned hashes, ZIP-1 memory peak, Electron without libgtk); notices current;
  FFmpeg all LGPL; real speech-model suites (`SPEECH_E2E=1`, turbo + tiny.en + tiny): 12 passed, 3 opt-in benches
  skipped; Remotion suites: compositions 157/157, motion 14 (+2 skipped), engine 53/53; `pnpm e2e` (LGPL-only, full
  build, incl. `script-fix.spec.ts`): 138 passed, 2 skipped. Merged to local `main`.
- ✅ Pushed `main` to origin with the user's authorization (2026-10-27, d5efb1b8..eb5ef1ad).

## 4. Decisions
- D5 Score windows are packed with the gap audio muted (SC-105: unmuted packing let readings use untranscribed speech
  in gaps and caused every false fix found; unpacked windows cost 24.7 s per speech minute on the VM, over target).
- D1 No schema bump: the script stays in `Sequence.cleanup.script` (shared, called "Script"); fixes are commands on
  existing word fields; the only new persisted field is the optional `Sequence.scriptFix` (rejections, settings),
  which older v10 builds keep on save.
- D2 Never delete ASR words (ad-libs can't be told from recogniser insertions); numbers, stylised spellings and
  headings are never rewritten.
- D3 Glossary prompting is optional and off by default (spike: helps names, once dropped real chatter).
- D4 Uncertain candidates are offered unselected ("Maybe"); agents never auto-apply them.

## 5. Costs (estimated from provider rates)
| Machine | Rate | Since | Note |
|---|---|---|---|
| Build VM (Hetzner cpx51) | $0.44/h | 2026-10-26 23:27 UTC | closed by the session restart ≈ 06:10 UTC (≈ $3) |
| Build VM #2 (Hetzner cpx51) | $0.44/h | 2026-10-27 06:18 UTC | final gate; lifetime 12 h |

## 6. Open questions / risks
- Proposal files with per-item `selected` are set aside as unreadable by an older engine (proposal store is engine
  state, not versioned with the project; nothing deleted).
- A subtitle whose words were re-timed far from the transcript is neither patched nor reported (scapply limitation).
- No verbatim ground truth of what the user said: recall must be estimated (adjudicated sample, injected errors).
- Prompting Whisper with script text can make it output script words that were not said; the spike measures it.

## 7. Log
- 2026-10-27 — programme started; VM rented; spike and code-map research launched; code map done; spike done; spec 17 written; scalign, scapply, scscore, scglossary launched; scscore, scalign, scglossary merged; scengine launched; scapply merged; scweb launched; integrated suite on 2ac215fc: 9,237 passed, only the 7 known failures; sccalib launched; scengine merged; scweb merged; integrated suite on 4bdd7fe3: typecheck passes, 9,341 tests passed, only the 7 known failures; lint
  failed on the new e2e spec's formatting only (fixed in c008b648); sccalib merged (spec SC-030 updated: unpacked windows by default); re-measured SC-037 with unpacked windows: 24.67 s per speech minute (48 encoder passes; identical decisions) → over
  the 20 s target; follow-up: packed windows with the gap audio muted (keeps one encoder pass per packed window,
  removes the untranscribed speech that caused the false fixes), validated and merged (b5041f1e): SC-105 targets hold
  (false fixes 1/558, 0 audio fixes in cleanup regions, 38/52 recognition errors, 0/55 deviations, 247/430 injected),
  VM long bench 13.62 s per speech minute (22 encoder passes; same 66 decisions); Mac CPU 3.68 s per speech minute;
  muted WebGPU cost not measured (the Mac went onto battery). origin/main has no new commits; final gate next.
- 2026-10-27 — Orquester session restart closed the build VM mid-gate (no code lost: all work is in local git);
  replacement VM rented with the user's approval and provisioned; final gate re-run on b5041f1e: passed; merged to local `main`.
