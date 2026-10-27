# Script-guided transcript correction (spec 17)

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
