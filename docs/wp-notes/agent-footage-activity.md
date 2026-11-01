# Agent footage editing — agent activity (spec 18 §2.9 AF-ACT)

What agents do in an open editor window: the Agent Activity panel (AF-ACT-001), the header status chip (AF-ACT-002)
and burst toasts (AF-ACT-003). Web only (`apps/web`); no engine, MCP or schema change.

## Code

| Part | Where |
|---|---|
| Activity entry → History entry (`historyEntryId`) | `apps/web/src/agent-bridge/bridge.ts` (`record`, `historyEntryFor`) |
| Outcomes, filters, undo plans, `undoAgentEdits` | `apps/web/src/agent-activity/model.ts` |
| Burst grouping, toast text | `apps/web/src/agent-activity/bursts.ts` |
| Burst toasts | `apps/web/src/agent-activity/toasts.ts` (wired by `shell/AgentApprovals.tsx`) |
| Agent presence (chip state machine) | `apps/web/src/agent-activity/presence.ts`, `hooks.ts`, `text.ts` |
| Header chip | `apps/web/src/agent-activity/StatusChip.tsx`, mounted in `shell/header/HeaderBar.tsx` |
| Panel | `apps/web/src/panels/agentActivity/` (kind `agentActivity`) |
| Tests | `apps/web/test/agent-activity-model.test.ts`, `apps/web/test/agent-activity-ui.test.tsx` |

## Behaviour

### Undo rule (panel and toast)

Agent transactions are one History entry each and never coalesce (`History.push` merges only `user` entries). An
activity entry records the id of the entry it made (looked up by `revisionAfter`, which only grows; queued
transactions may all have committed before the bridge records the first). `planAgentUndo(ids, history)` allows Undo
only for the contiguous run of those agent entries at the top of the applied stack:

- an edit on top of them (the user's or another agent's) → refused, "Newer edits came after it; use the History panel";
- a user edit between them → refused (`interleaved`);
- some already undone → the rest is undone; all undone → "Already undone"; cleared or past the history capacity →
  "No longer in History".

`undoAgentEdits` re-checks before every step that the top entry is one of them and calls `session.undo({agent})`
(S01:UND-008 ownership), so the user's own work is never undone. Read-only projects and an active drag refuse
(`busy`). It never throws: a failure comes back as `error` with its message (toast and button handlers).

### Panel (AF-ACT-001)

Window ▸ Agent Activity, the palette (`panel.focus.agentActivity`) or the chip. Not part of a factory workspace (no
workspace migration); it docks with History, else Jobs, else floats. Top: each active agent with its state and current
step or error. Filters: agent and outcome (applied, failed, denied = user denied or approval timed out, dry run). Rows,
newest first: time, agent, label and command summary, outcome, Undo (only rows with a History entry; disabled with the
reason otherwise). ↑/↓/Home/End move between rows (roving tab stop), Enter / ▸ shows counts, revision, transport and
every error and warning; Tab reaches the row's Undo. The log is the bridge's (in memory, per window, newest 200), so the
list is not virtualised.

### Chip (AF-ACT-002)

Neither the engine nor the relay keeps a list of MCP clients (stdio `jasper-mcp` makes plain HTTP requests named by
`x-jasper-agent`), so "connected" is inferred in the window from what an agent does in this project — an assumption,
not an engine fact. An agent is shown while it has a pending approval, a proposal it waits on or a running / queued
job, or did something within `PRESENCE_MS` = 10 min. State, most urgent first:

| State | When | Chip |
|---|---|---|
| approval | one of its requests waits for Approve / Deny | amber dot, badge |
| review | it polls one of its proposals (`waiting`), or an undecided proposal of its changed within 10 min | agent dot, badge |
| error | its latest applied-or-failed transaction or finished job failed, within `ERROR_MS` = 5 min (denials and failed dry runs are not errors) | red dot, "Error" |
| working | a transaction within `WORKING_MS` = 10 s, or a job of its running | pulsing agent dot (static under reduced motion) |
| idle | otherwise | grey dot |

The windows are UI choices (no source); `presence.ts` exports them and the tests pin the transitions.
`nextChangeAt` schedules the one re-evaluation time alone causes. Badge = approvals + reviews. The chip is a button;
its accessible name and tooltip list every agent with state and step (spec 05 AG-010), and say when the WS `/agent`
link is down. A render failure in the chip shows a small "Agents" error marker instead of taking the header down.

### Burst toast (AF-ACT-003)

Applied, non-dry-run transactions from external agents (relay) join the current burst while the previous one is at
most `BURST_WINDOW_MS` = 2 s older and the History entry right below the new one is the burst's last; otherwise a new
burst starts (so a user edit or an undo in between splits it). One toast per burst (`agent-burst:<id>`):
"Agent: <label>" for one transaction, "Agent: N edits" for more, with agents and changed items. Its Undo runs
`undoAgentEdits` on the burst; the result ("Undid N agent edits", or the refusal and reason) is a separate toast,
because the toast host closes the toast whose action ran.

## Validation

- `pnpm exec vitest run apps/web/test/agent-activity-model.test.ts apps/web/test/agent-activity-ui.test.tsx
  --maxWorkers=1`: 29 tests (outcomes, filters, undo plans incl. interleaved / newer user edits, burst grouping with
  explicit times and fake `Date`, chip state machine and timers, panel rows / filters / keyboard / Undo availability,
  chip states and accessible names, toast collapse and Undo through `ToastHost`).
- Existing: `agent-bridge`, `agent-ui-guard`, `agent-ui`, `shell`, `shell-render`, `polish-open`,
  `workspace-migration` tests pass.
- Running dev stack (engine 48100, Vite 5300), agents driven with `apps/mcp/src/jasper.ts run -` as `claude-code` and
  `codex`: three transactions → one "Agent: 3 edits" toast, chip "claude-code · Working"; a failed codex transaction →
  chip "2 agents · Error", panel rows with Failed / Applied and Undo only on the top row; row Undo removed exactly that
  marker; after a user marker (M) the agent rows' Undo was disabled; burst Undo removed exactly the burst and showed
  "Undid 2 agent edits".

## Limits

- Presence is inferred (above); an agent that only reads (queries, MCP resources) is not shown.
- The log and bursts live in the window: a reload starts empty (History keeps the entries and their agent markers).
- In-page (`window.jasper`) and console transactions are logged in the panel but get no toast (as before).
- The "review" state needs proposals by agents (spec 18 AF-PROP); verified by tests, not in the running app.
