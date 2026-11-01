# Agent footage editing: brief and agent notes (spec 18 §2.8, AF-BRF)

The human states what a video should be once — on Home or in Sequence ▸ Brief… — and agents read it before they cut;
agents keep notes about the project for later sessions. Spec: [18-agent-footage-editing.md](../specs/18-agent-footage-editing.md)
§2.8. Schema and repair details: [project-files.md](../project-files.md) "Fields added in v11".

## Model (`packages/project/src/brief/model.ts`, schema v11)

- `Sequence.brief = {text ≤ 8 000, platform?: DeliveryTargetId | null, targetDurationSec?: 1…36 000 | null,
  aspect?: DeliveryAspect | null}`. Platform ids and aspects come from `delivery/targets.ts` (`DELIVERY_TARGETS`,
  `isDeliveryTargetId`, `DELIVERY_ASPECTS`). Stored canonically: no null fields, an empty brief is removed.
  `briefAspect` = the brief's aspect, else its platform's.
- `ProjectDocument.agentNotes = {entries: [{id: agn_…, at: ISO time, author 1…64, text 1…4 000}] ≤ 500}` (oldest first).
- Read leniently (`z.custom`), checked by INV-BRIEF / INV-AGENT-NOTES, repaired conservatively on load
  (`repair-brief`, `repair-agent-notes`, reported to the user as `W_REPAIRED` open issues like every load repair).
- v10 → v11 is a version bump only (`migrations.ts`); fixture `test/fixtures/schema-v11.jasper`.

## Commands (`commands/handlers/brief.ts`), one undo step each

| Command | Behaviour | Refusals |
|---|---|---|
| `sequence.setBrief {sequenceId?, brief: {text?, platform?, targetDurationSec?, aspect?} \| null}` | given fields replace the stored ones, omitted kept, null clears one; `brief: null` removes it | `E_SCHEMA` (unknown platform / aspect, length out of range, text > 8 000, unknown keys), `E_NOT_FOUND` |
| `project.addAgentNote {text, author?}` | an agent transaction signs the note with its agent name (`origin.agent`, cut to 64); `author` (default "user") only for non-agent origins; `at` = the context clock | `E_SCHEMA` (empty / blank / long text or author), `E_LIMIT` at 500 notes, `E_INVALID_PARAM` when the stored notes are unreadable |
| `project.removeAgentNote {noteId}` | removes the note; the field goes when the last note goes | `E_NOT_FOUND`; agents need the user's approval (`APPROVAL_COMMANDS`) |

## MCP (`apps/mcp/src/tools/brief.ts`)

`get_brief {projectId, sequenceId?}` (brief, platform name / aspect / form, sequence frame and whether it matches,
number of notes), `set_brief` (fields merged, null clears, `clear: true` removes; refuses an empty call or `clear` with
fields), `list_agent_notes {limit?}` (oldest first; `limit` = newest N), `add_agent_note {text}` (signed with the MCP
client's name through the transaction origin). No tool removes notes: removal is the user's; through `apply_commands`
it needs approval.

## Editor

- **Home ▸ Describe your video** (left rail; also "Start with the agent" in the empty state, spec 05 HD-020): description,
  platform, frame (default: the platform's), target length ("45", "45 s", "1:30", "2 min"), footage by drop or picker
  (native picker on desktop). Create makes the project named after the description's first line with the sequence the
  brief implies (`sequenceShapeFor`): 9:16 → `vertical-1080x1920-30`, 1:1 → `square-1080-30`, 4:5 (no preset) → the
  30 fps HD preset changed to 1080×1350 (`makeSequenceSettings`), 16:9 or nothing → the Home default `hd-1080p-29.97`.
  The editor then (`home/start-brief.ts`, `use-start-brief.ts`, after autosave has attached) applies one
  "Describe Your Video" step (frame change + brief), imports the files into the project root (`EngineImportService`,
  its own progress and failure summary), and opens Help ▸ Connect an AI Agent… unless an agent is connected; with one
  it says "Brief saved for <agent>".
- **Agent connected** = `GET /api/agent/presence` lists an agent: the engine remembers (in memory, ≤ 32 names) the
  `x-jasper-agent` header jasper-mcp sends on every engine request and lists names seen in the last 15 minutes
  (`apps/engine/src/agent/presence.ts`). Assumption: an agent that is configured but has not called the engine since
  the engine started is "not connected" (the dialog still shows how to connect; already-connected users can close it).
- **Sequence ▸ Brief…** (`sequence.brief`, `brief/BriefDialog.tsx`): edits the brief (Save = one "Edit Brief" step;
  a note when the sequence frame differs from the asked aspect) and lists agent notes newest first with Remove (one
  "Remove Agent Note" step, Undo in the dialog, or Edit ▸ Undo / History). Read-only projects show both disabled.
- **The brief changing under an open Brief… dialog** (an agent's `set_brief`, an undo): the form remembers the brief it
  is based on. Fields the user has not edited follow the new brief; edited fields keep the user's value; a notice names
  the agent (the newest History entry's origin) and, for a field both changed, shows the agent's value. Save writes only
  the fields the user edited (`editedBriefPatch`), so the agent's other changes stay; for a field both edited, the
  user's Save replaces the agent's value they were shown (one "Edit Brief" step, undoable). Nothing edited = Save writes
  nothing (`rebaseBriefForm`, `apps/web/test/brief.test.tsx`).

## Validation (2026-10-31)

- `packages/project/test/brief.test.ts` (commands, refusals, invariants, repair, fast-check properties, save/load),
  `schema-history.test.ts` (v11 fixture, step 10→11), `packages/session/test/brief-history.test.ts` (one undo step each,
  exact undo/redo, read-only refusal), `apps/mcp/test/brief.test.ts`, `apps/engine/test/agent-presence.test.ts`,
  `apps/web/test/brief.test.tsx`.
- Exercised in the running app (dev stack, headless Chromium through Playwright): Describe → Instagram Reels gives a
  1080×1920 sequence, both files in the Project panel, the brief in Sequence ▸ Brief…, and Connect an AI Agent…; with
  an agent seen first, LinkedIn gives 1080×1080 and the "Brief saved for claude-code" notice; notes added through
  `/api/agent/tx` appear, Remove and Undo work, the saved file is schema 11.

## Limits

- Presence is per engine process and only sees agents that called the engine; it is not a live connection state.
- The pending start lives in memory: reloading the page between Create and the editor opening loses the brief and files
  (the project stays, empty).
- The agent activity toast reports a note as "0 items changed" (notes are not entities; the toast is AF-ACT's).
