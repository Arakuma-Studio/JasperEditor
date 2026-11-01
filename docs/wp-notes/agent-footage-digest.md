# Agent footage editing — footage digest and takes (spec 18 §2.2 AF-DIG, AF-TAK)

Status: implemented 2026-10-31. Spec: [`docs/specs/18-agent-footage-editing.md`](../specs/18-agent-footage-editing.md) §2.2.

## What it does

An agent reads all footage as text before it cuts:

- `packFootageDigest(doc, {mediaIds?, sequenceId?, maxChars?})` (`packages/project/src/footage/digest.ts`) renders
  every transcribed media plus every video / audio media with sound (or `mediaIds`, or one sequence in sequence time):

  ```
  # Footage digest: <project name>
  ## <mediaId> "<name>" (43.0 s, 1920×1080 29.97 fps, 8 phrases, speakers S0 S1)
    [002.52-005.36] S0 Ninety percent of what a web agent does is ~completely wasted.
  ## <mediaId> "<name>" (12.0 s, audio only) — no transcript: transcribe it with `transcribe`
  ```

- `findTakes(doc, {mediaIds?, minSimilarity?})` (`packages/project/src/footage/takes.ts`) groups phrases that say the
  same line across files.
- MCP (`apps/mcp/src/tools/footage.ts`): `get_footage_digest {projectId, mediaIds?, sequenceId?, maxChars?}`,
  `find_takes {projectId, mediaIds?, minSimilarity?}` (both read-only) and the resource
  `jasper://projects/{projectId}/footage` (the digest with its defaults). `FOOTAGE_GUIDE` joins the server guide.
- `import_media {transcribe?: boolean | {model?, language?}}` queues one transcription job per imported media with
  sound and lists the job ids (`transcriptionJobs`, per file `transcription: {jobId} | {skipped} | {error}`); the agent
  commits them with `transcribe {projectId, jobIds}` (one undo step), as `transcribe {wait: false}` already worked.
- The editor's Preferences ▸ Transcription "Transcribe on import" now also transcribes media an agent imports while
  the editor is open (`apps/web/src/speech/auto.tsx`).

## Behaviour and thresholds

| Rule | Value | Source |
|---|---|---|
| Phrase split: gap between words | ≥ 0.5 s (`PHRASE_GAP_S`) | video-use (MIT), `licenses/ported/video-use.md` |
| Phrase split: speaker change, caption break (`breakBefore` line / segment) | always | spec 18 AF-DIG-001 |
| Phrase split: length | a phrase never grows past 12 s (`PHRASE_MAX_S`); one longer word stays one phrase | spec |
| Low-confidence mark `~` | confidence < 0.6 (`DIGEST_LOW_CONFIDENCE`) | spec |
| Times | seconds, 2 decimals (rounded hundredths of the flicks), zero-padded to the widest time shown, at least 3 integer digits | spec; the 3-digit minimum is video-use's `[002.52-…]` form (assumption: the spec example pads a 43 s media to 3 digits) |
| `maxChars` | default 40 000, clamped 1 000…200 000 (`DIGEST_*`) | spec |
| Media order | Project panel bin order (depth-first walk of `rootItems` / bin `children`), then name, then id; media without a Project item last | spec |
| Take similarity | 2·LCS / (\|a\| + \|b\|) over normalised word tokens, ≥ `minSimilarity` (default 0.6; MCP accepts 0.3…1) | spec; LCS from the cleanup rules (`cleanup/rules.ts lcs`) |
| Normalisation | `cleanupNorm` (case, accents, punctuation) and the vocalic fillers of the transcript language (`builtinLists(cleanupLanguageOf(language)).fillers`) | spec 14 lists |
| Take minimum | ≥ 2 normalised tokens (`TAKE_MIN_TOKENS`); "Yes." / "Okay" are not takes of a line | assumption (avoids grouping every one-word reply) |
| `complete` | last word ends with `. ! ? … 。 ！ ？ ؟` (closing quotes / brackets allowed) and the cleanup detector's `ruleRestarts` (restart, false start) and `ruleStutters` (repeat, cut-off word) claim no word of it, with the Natural preset thresholds | spec; stutters counted as restarts is an interpretation |
| `suggested` | the last complete member (members in media order, then time), else the last member | spec 14's default (`detectCleanup`) |
| Bounds | ≤ 5 000 compared phrases (`E_TOO_LARGE`, `details.media` = phrases per media so the agent can narrow with `mediaIds`); ≤ 200 tokens per phrase; LCS work capped at 2·10⁸ cells (`E_TOO_LARGE`) | spec / implementation |

Details:

- Words with nonfinite, negative or reversed times, or no text after whitespace folding, are skipped; words starting
  at or after the media duration are dropped and the rest clamped to it. Text and names are folded to one line
  (control characters and whitespace runs → one space), names cut at 120 characters and quoted with `\"` escapes, so
  a transcript or item name cannot forge digest lines.
- Speakers are labelled `S0`, `S1`… per media in order of first appearance (transcript keys vary: `S1`, `s1`, custom
  names); in sequence mode one label per (transcript, speaker key).
- Truncation: media are laid out in order; the first media that does not fit (with room for the closing notice) ends
  the digest with `… N more media not shown: pass mediaIds`. A first media larger than the budget is cut at a phrase
  line with `  … P more phrases not shown: pass a larger maxChars (≤ 200000)`. The MCP result adds a JSON block with
  `notShown` ids / `cutPhrases`.
- Sequence mode uses `sequenceWords` (top audio track first, clipped to clips) and the sequence's Project item name;
  `mediaIds` with `sequenceId` is `E_INVALID_PARAM`.
- Grouping: candidate pairs come from a prefix-filtered index of token occurrences ordered rarest first (exact for this
  ratio: two phrases with ratio ≥ s share an occurrence within their first |x| − ⌈s·|x|/(2−s)⌉ + 1), then a length
  filter, then LCS; groups are connected components (union-find), so a member may be similar only to another member.
- Transcribe-on-import for agents: `doc.changed` with an `{agent}` origin is handled like a user import (not undo /
  redo, not read-only). Media that already have a transcript, or whose engine key has a transcription job queued or
  running for the project (`GET /api/jobs?active=1&projectId=`), are skipped. `import_media {transcribe}` queues its
  jobs before the import transaction, so the editor sees them and does not transcribe twice; if the transaction is
  refused (or the engine fails mid-queue) the queued jobs are cancelled. If the job list cannot be read the editor
  proceeds (the engine's job dedupe key still stops an identical job).

## Tests

- `packages/project/test/footage-digest.test.ts`, `footage-takes.test.ts`: phrasing rules, format, padding, order,
  `mediaIds`, sequence mode, truncation (whole media and a cut first media), line-forging names, takes across files,
  restarts / stutters, minSimilarity, E_TOO_LARGE.
- `packages/project/test/footage-property.test.ts` (fast-check, AF-DIG-004): never throws on arbitrary transcripts
  (NaN / infinite / negative / reversed / unsorted times, odd text, unknown durations); phrase times ordered and inside
  the bounds in the structure and the text; `maxChars` holds on long footage and only whole media (or a cut first
  media) are dropped; sequence digest never throws; take grouping deterministic and symmetric (input order of media and
  transcripts), a partition into groups of ≥ 2, and complete against a brute-force pairwise oracle; similarity
  symmetric in [0, 1]. Mutation-checked: loosening the budget check or dropping some unions makes them fail.
- `apps/mcp/test/footage.test.ts`: tools, resource, annotations, coded errors, `import_media` transcribe (per-file
  results, queued before the transaction, defaults, skip already-transcribed, model refusal, cancel on a refused
  import).
- `apps/web/test/speech.test.tsx`: agent-imported media are transcribed; media with a queued job are not.

Run: `pnpm exec vitest run packages/project/test/footage-*.test.ts apps/mcp/test/footage.test.ts
apps/mcp/test/speech.test.ts apps/mcp/test/conventions.test.ts apps/web/test/speech.test.tsx --maxWorkers=1`;
`pnpm --filter @jasper/project typecheck`, `--filter @jasper/mcp`, `--filter @jasper/web`.

## Limits

- Only `import_media` takes `transcribe`: the other import tools bring in stills, PDFs, layered documents, image
  sequences, sound-library effects or interchange timelines, which have no speech to transcribe.
- The agent must commit its transcription jobs (`transcribe {jobIds}`); the open editor does not commit jobs it did not
  start, so an agent that never commits leaves no transcript.
- A transcription job that finished before the editor processed the import transaction would not be seen as pending;
  the jobs are queued before the transaction and transcription takes at least the model load, so this is not expected.
- Takes are grouped by text only (no audio or picture comparison); transitive grouping can join two phrases that are
  each similar to a third but not to each other.
