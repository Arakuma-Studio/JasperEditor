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
- 🔄 Spike on the user's Mac (alignment, audio verification, false-correction tests, glossary prompting, cost).
- 🔄 Code map of every affected surface + proposed work-package split.
- ⏳ Spec 17 (`docs/specs/17-script-correction.md`).
- ⏳ Implementation work packages (parallel, worktrees `.claude/worktrees/sc-<name>`, integration branch
  `feat/script-correction`).
- ⏳ Integration: fetch/merge `origin/main`, full gate + e2e + render suites on the VM, merge to `main`.

## 4. Decisions
(none yet)

## 5. Costs (estimated from provider rates)
| Machine | Rate | Since | Note |
|---|---|---|---|
| Build VM (Hetzner cpx51) | $0.44/h | 2026-10-26 23:27 UTC | lifetime 36 h |

## 6. Open questions / risks
- No verbatim ground truth of what the user said: recall must be estimated (adjudicated sample, injected errors).
- Prompting Whisper with script text can make it output script words that were not said; the spike measures it.

## 7. Log
- 2026-10-27 — programme started; VM rented; spike and code-map research launched.
