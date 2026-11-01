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
| Engine-reported agents (poller) | `apps/web/src/agent-activity/engine-presence.ts` (`GET /api/agent/presence`, AF-BRF-005) |
| Header chip | `apps/web/src/agent-activity/StatusChip.tsx`, mounted in `shell/header/HeaderBar.tsx` |
| Panel | `apps/web/src/panels/agentActivity/` (kind `agentActivity`) |
| Tests | `apps/web/test/agent-activity-model.test.ts`, `agent-activity-ui.test.tsx`, `agent-activity-engine-presence.test.ts` |

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

An agent is shown while the engine lists it as present (`GET /api/agent/presence`: jasper-mcp names its agent on every
engine request with `x-jasper-agent`; the engine lists the names seen in the last 15 min, so an agent that only reads
is shown too), or while it has a pending approval, a proposal it waits on or a running / queued job in this window, or
did something here within `PRESENCE_MS` = 10 min. The engine's list only makes an agent appear: its state comes from
the window's signals, idle without any. The list is polled every `PRESENCE_POLL_MS` = 15 s, one poller per engine
client, only while the chip or the panel is mounted and the engine is connected; the answer is validated with
`AgentPresenceSchema`, and a failed or malformed answer empties the list quietly (the window's own inference stands,
the next poll retries; no console error). State, most urgent first:

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
  --maxWorkers=1`: 32 tests (outcomes, filters, undo plans incl. interleaved / newer user edits, burst grouping with
  explicit times and fake `Date`, chip state machine and timers, panel rows / filters / keyboard / Undo availability,
  chip states and accessible names, toast collapse and Undo through `ToastHost`).
- `apps/web/test/agent-activity-engine-presence.test.ts`: 3 tests (polls only while subscribed, unchanged lists do not
  re-render, failures and malformed answers empty the list quietly and polling goes on, late answers dropped).
- Existing: `agent-bridge`, `agent-ui-guard`, `agent-ui`, `shell`, `shell-render`, `polish-open`,
  `workspace-migration` tests pass.
- Running dev stack (engine 48100, Vite 5300), agents driven with `apps/mcp/src/jasper.ts run -` as `claude-code` and
  `codex`: three transactions → one "Agent: 3 edits" toast, chip "claude-code · Working"; a failed codex transaction →
  chip "2 agents · Error", panel rows with Failed / Applied and Undo only on the top row; row Undo removed exactly that
  marker; after a user marker (M) the agent rows' Undo was disabled; burst Undo removed exactly the burst and showed
  "Undid 2 agent edits".

## Limits

- Presence relies on the agent naming itself: the engine lists only jasper-mcp clients (the `x-jasper-agent`
  header), by name, for 15 min after their last request; an agent that stopped stays listed (idle) until then, and an
  engine without the presence route (older build) leaves only the window's inference. Engine names and transaction
  origins come from the same jasper-mcp name, so they merge into one row.
- The log and bursts live in the window: a reload starts empty (History keeps the entries and their agent markers).
- In-page (`window.jasper`) and console transactions are logged in the panel but get no toast (as before).
- The "review" state needs proposals by agents (spec 18 AF-PROP); verified by tests, not in the running app.
