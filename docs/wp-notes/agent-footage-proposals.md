# Agent footage editing — reviewable agent edits (spec 18 §2.4, AF-PROP)

An agent's own multi-step cut lands as ONE reviewable proposal (feature `rough-cut`) instead of a series of
`apply_commands` History entries. The user sees the agent's strategy, every edit as a Review row with its beat, quote
and reason, the timeline ghosts and A/B, and applies what they keep as one undo step.

## Behaviour

| Requirement | Where | Behaviour |
|---|---|---|
| AF-PROP-001 | `packages/project/src/proposals/features.ts` (`ROUGH_CUT_FEATURE`) | Feature `rough-cut`, name "Rough cut", groups Selects / Removed / Retakes / Reorder / B-roll / Other, noun "1 edit" / "{0} edits", `agentAccept: {setting: 'project', default: false}`, producer `propose_edits`. The engine registers its policy through `projectSettingFeatures()` like the other project-setting features; repair of an unreadable `settings.agentProposals` writes `rough-cut: false` with the others. |
| AF-PROP-002 | `packages/project/src/proposals/rough-cut.ts`, `validate.ts` (`proposalItemFailures`, `ProposalContext.expectedRevision`), `apps/engine/src/proposals/service.ts` (`create`), `packages/api/src/proposals.ts`, `apps/mcp/src/tools/proposals.ts` (`propose_edits`, `ghostSummary`) | MCP `propose_edits {projectId, sequenceId, title, strategy, expectedRevision?, items}`. Items: `{group, reason, beat?, quote?, commands, alternatives?}`; limits in `ROUGH_CUT_LIMITS` (≤ 200 items, 1–100 commands per item or alternative, ≤ 2 000 commands in all *alternatives included*, reason 1–280, beat ≤ 40, quote ≤ 280, strategy 1–2 000 characters and ≤ 8 sentences). Argument refusals never reach the engine. The draft is sent with `allOrNothing: true`: the engine creates the proposal through the ordinary `createProposal` dry runs (each item alone, then all together) and, when any item or alternative fails, answers 422 `PROPOSAL_INVALID` with `detail.items` = `ProposalItemFailure[]` (`index`, `itemId`, `alternative?`, `code`, `message`, `commandIndex` inside that item; `E_CONFLICT` when the item only fails together with the items before it) and stores nothing; MCP returns one `E_PROPOSAL_INVALID` error with `details.failures`. Malformed commands (400 `VALIDATION_FAILED`) are mapped to the same failure list by their `items.<i>` path. `expectedRevision` adds the fast-forward rule of `apply_commands` (S01:AGT-010) to every dry run: an item touching an entity changed since is `E_REVISION_MISMATCH`; a revision ahead of the document is 409 `REVISION_CONFLICT` → `E_REVISION_MISMATCH`. The result: proposal id, counts, items per group, `ghostSummary` (clips created / removed / moved / trimmed / changed, tracks created / removed, counted once per entity over all undecided items), the per-item ghost table of `get_proposal`, and the `wait_for_proposal` hint. Item ids are `e<index>`; the label is "beat: reason" (≤ 200). The strategy is stored as the proposal's `summary` (no new stored field: proposals of older engines load unchanged). |
| AF-PROP-003 | `apps/web/src/proposals/rough-cut.tsx`, `apps/web/src/panels/review/ReviewPanel.tsx` | The Review panel shows "Strategy …" above the items of a rough-cut proposal; each row shows the beat chip and the reason on its first line and the quoted words on its second; the details show beat and quote, the why-line is the reason (an alternative's own reason when selected). Ghosts, A/B, Apply n of m, stale rows and the one-undo apply are the panel's own, unchanged. The card reads "<agent> proposes <title>: N edits". `get_proposal` items carry `why` (the reason), `beat` and `quote`. |
| AF-PROP-004 | Project Settings ▸ General ▸ Agent Proposals; `GET …/proposal-features`, `list_proposal_features` | "Allow agents to apply rough cut proposals" appears unchecked by default (the list comes from the feature table); the help text says rough cuts are off by default. |

Item order matters: items apply in order as one transaction. The tool description tells agents to address clips by
id and to list ripple edits from the end of the timeline to the start, so the frame numbers of earlier items stay
valid whichever subset the user keeps.

## Validation

- `packages/project/test/rough-cut-proposal.test.ts`: feature table and policy (off by default, on when allowed);
  input limits (bad group, lengths, 201 items, 101 commands, 2 001 commands with and without alternatives, strategy
  length and sentences); sentence counting (fast-check); lenient meta reader (fast-check); `proposalItemFailures`
  (missing clip with its command index, failing alternative, conflict with an earlier item); `expectedRevision` with
  and without a revision map.
- `packages/project/test/proposal-features.test.ts`: repair writes `rough-cut: false`.
- `apps/engine/test/proposals-rough-cut.test.ts`: features listing; agent accept → 403 `APPROVAL_REQUIRED` by
  default, editor accept = one transaction (revision 3 → 4); allowed in Project Settings → agent accept works; a
  conflicting user edit → stale, accept refused 409; `allOrNothing` refusal (422 listing indices 1 and 3, nothing
  stored), malformed command 400, the lenient path unchanged; `expectedRevision` (only the item touching the changed
  clip refused; ahead → 409).
- `apps/mcp/test/propose-edits.test.ts`: the draft sent, the result (ghost summary: created 1 / removed 1 / moved 1 /
  trimmed 1, ghost table rows, hint), `E_PROPOSAL_INVALID` with failures (dry-run and malformed), argument refusals
  without an engine call, `expectedRevision` pass-through and `E_REVISION_MISMATCH`.
- `apps/web/test/rough-cut-review.test.tsx`: strategy above the list, beat / quote / reason per row in the declared
  groups, Apply of both items undone by ONE undo, the card sentence.
- `apps/web/test/agent-proposals-settings.test.tsx`: the setting is listed unchecked, saved as an undoable edit.

## Limits

- The strategy's sentence count is a heuristic (an end mark followed by a capital letter, digit or quote, or the end;
  CJK end marks always count): abbreviations followed by a capitalised word ("Dr. Smith") count as a sentence end.
- There is no refresher for rough cuts: stale items are re-proposed by the agent (`refresh_proposal` answers
  `E_NOT_REFRESHABLE`, as for any feature without a producer re-plan).
- Without the engine's revision map reaching back to `expectedRevision` (an engine restart, edits it did not see),
  every item touching anything is refused as stale — the same rule as `apply_commands`.

## Exercised in the running app (2026-11-01)

Dev stack (engine 48040, Vite 5240, appdir `/tmp/af-prop-appdir`), project of four solid "takes"; the in-repo MCP
server (stdio) called `propose_edits`: a draft with an unknown clip was refused (`E_PROPOSAL_INVALID`, item 0,
commandIndex 0, nothing stored); a three-item cut (outro trim, B-roll on V2, ripple-remove of the stumbled intro
take) was stored with ghost summary created 1 / removed 1 / moved 2 / trimmed 1. In headless Chromium (Playwright)
the card read "Claude proposes Tight 10 s cut: 3 edits" with the strategy; the Review panel showed the strategy, the
Selects / Retakes / B-roll groups, beat chips, quotes and reasons, the details (beat, quote, reason, ghost facts) and
the timeline ghosts; Accept all → Apply asked "Apply 3 of 3? Also removes 1 of your clips: “Intro take 1”", applied
("Applied 3 of 3 edits from Claude") and the saved revision went 1 → 2 (one transaction). Narrow panels truncate a long
reason after the beat chip (full text in its tooltip and the details).
