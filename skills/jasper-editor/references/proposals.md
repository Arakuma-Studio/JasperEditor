# Proposing a cut

A rough cut is one proposal the user reviews in the Review panel: ghosts on the timeline, each item with its
beat, quote and reason, Apply n of m, and one undo step for everything applied. `propose_edits` stores it;
`wait_for_proposal` reports the decisions. `describe_tool` {"name": "propose_edits"} shows the exact schema.

## Shape

- `title`: what the cut is ("Reels cut, 30 s").
- `strategy`: the plan in 1–8 sentences (≤ 2 000 characters): the story order, what goes, which takes win and why.
  The user reads it above the items, so write it for them.
- `items` (≤ 200, ≤ 2 000 commands in total), one per editorial decision:
  - `group`: Selects, Removed, Retakes, Reorder, B-roll or Other.
  - `reason` (≤ 280 characters): why, in the user's terms ("second take is complete; first one restarts").
  - `beat` (≤ 40): the story beat ("Hook", "Problem", "Demo", "Call to action").
  - `quote` (≤ 280): the words kept or cut, copied from the digest.
  - `commands`: 1–100 commands as `apply_commands` takes them (`describe_commands` for schemas).
  - `alternatives` (optional): other command sets the user can cycle (another take of the same line).
- `expectedRevision` (optional): the revision you planned against; a changed project is refused instead of
  half-applied.

Every item is dry-run against the current document before anything is stored. One failure returns an error
listing each failing item index with its command error, and nothing is stored: fix those items and send the
whole proposal again.

## Writing good items

- One item per decision the user may want to undo separately: a removed tangent, a chosen take, a moved section.
- Take quotes and times from `get_footage_digest` / `find_takes`, not from memory; prefer the suggested take of a
  group unless you can say why another is better (complete sentence, no restart, steadier delivery).
- Cut on phrase boundaries the digest shows (silences ≥ 0.5 s); check unsure openings and endings with
  `view_media_range` before proposing them.
- Keep cosmetic passes (subtitles, music, punch-ins) out of the rough cut: they have their own proposal tools once
  the cut is applied.

## After proposing

1. Tell the user in two or three lines what the proposal does and that it waits in the Review panel.
2. `wait_for_proposal` (call it again to keep waiting). Per item: accepted, rejected, pending, stale, invalid,
   swapped (they chose an alternative), and their notes.
3. Rejected items with notes: propose the change they asked for as a new, smaller proposal. Stale items: the edit
   changed under them; `refresh_proposal` when the feature supports it, else propose again.
4. Never accept your own rough cut: the rough-cut feature lets agents apply only when Project Settings ▸ Agent
   Proposals allows it, and `accept_proposal` is refused with E_APPROVAL_REQUIRED otherwise. Do not retry; ask.
