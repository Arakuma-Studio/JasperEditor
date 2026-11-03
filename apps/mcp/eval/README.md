# MCP tool-use eval

Checks whether agents use JasperEditor's MCP tools correctly, and proves that text earns its bytes. A `bad` case reproduces
a real mistake, a `guard` protects a good behaviour a change could lose, and a `control` is ordinary work where a trigger
word must not pull in the tools. Run it when a change touches what a model sees: tool names, descriptions, schemas,
results, errors or the instructions (`src/agent-guide.ts`).

## How a sample runs

- A real `claude -p` or `codex exec` chat. No SDK dependency: the Claude Agent SDK is proprietary, and AGENTS.md §2 keeps
  dependencies permissive.
- The server is the real `createJasperMcpServer` from a checkout (`--source-root`, default this one), so its tool list,
  instructions, toolset filter, strict validation, handlers, hints and errors are always the current ones. Only the
  engine is fake (`fake-engine.ts`): documents go through the real command system and queries, so an edit really changes
  the project and a bad command gets its real `E_*`.
- An engine call the fake does not model fails loudly and marks the sample `invalid`: that is an eval bug.
- The cwd is a throwaway git repo of the case's `files`. Claude's Bash and file tools pass through
  `sandbox/claude-hook.mjs`: commands that only read inside the cwd run, others get the case's canned `shell` output or a
  line that invents nothing, and file tools stay in the cwd. Codex runs read-only with no network and shims for the
  usual commands. Delegation, web tools and questions are off.
- The grader reads the stub's own call log, so a case grades the same on both harnesses, and `call_tool` counts as the
  tool it ran. Checks are deterministic (`grade.ts`); no model judges.

## Accounts

Model calls use subscription accounts managed in Orquester, never an API key. `--account` takes a label, the part of the
label before `@`, or an id prefix, comma-separated to spread a run. There is no default, and the system login is refused.
Check quota first with Orquester's `get_usage`, and skip accounts at their limit or with `needsReauth`.

**Credentials stay in the account's home.** OAuth refresh tokens rotate and are single-use, so a refresh that lands in a
copy strands the real login, and two processes spending one token can log it out. So (`accounts.ts`):

- A sample gets `CLAUDE_CONFIG_DIR` / `CODEX_HOME` set to the real home and the auth variables removed. Never add a
  temporary home, and never copy or link `.credentials.json` or `auth.json`. For config isolation use flags instead:
  Claude `--setting-sources "" --strict-mcp-config`, Codex `--ignore-user-config` (its login still comes from `CODEX_HOME`).
- A sample starts only with at least 25 minutes left on the access token and is killed at 6 minutes. A CLI refreshes
  only in its last 5 minutes, so an eval process never spends a refresh token: the Orquester daemon renews them. Nothing
  reads more than the expiry, and nothing writes these files.
- A login failure stops the whole run instead of retrying a dead login.
- After a run each account prints whether its credentials were untouched or renewed in place, and its `needsReauth`.
- Cleanup removes only the sample's own `projects/<cwd slug>`, and refuses any path that is not an eval cwd.

## Run

```sh
cd apps/mcp
pnpm eval --dry-run                                    # build every case, no model calls
pnpm eval:measure                                      # what the model receives, per context
pnpm eval:measure --write-budget                       # after a real reduction: lower budget.json
pnpm eval --account <label> --case <id> --samples 1 --out /tmp/mcpeval/check
pnpm eval --account <a>,<b> --source-root <base checkout> --out /tmp/mcpeval/base
pnpm eval --account <a>,<b> --out /tmp/mcpeval/after --baseline /tmp/mcpeval/base/results.jsonl
pnpm eval --harness codex --account <label> --concurrency 2 --out /tmp/mcpeval/codex
```

Flags: `--harness claude|codex`, `--model` (defaults `claude-sonnet-5-5`, `gpt-6-astra`), `--effort`, `--case <ids>`,
`--samples` (default 2, with a third when they disagree), `--concurrency`, `--max-turns`, `--baseline`, `--source-root`.
`--out` must be outside the repository.

A case fails when half or more of its samples fail. Compare against a baseline on the same model, never an absolute
score, and decide wording on at least 4 samples: 2 cannot tell 2/4 from 4/4. Read what the agent did before trusting a
failure: most early failures are eval bugs.

## Add a case

Cases are JSON lines in `cases/`; `case.ts` documents every field. Name the true `source`: a chat and date, a commit, a
measurement, or a baseline probe. Use synthetic data only. Use `{{project}}`, `{{clip}}`, `{{mediaA}}`, `{{cwd}}` for ids and
paths. A `bad` case must fail on the old text. Prefer `setup.faults` over prior turns: the situation then comes from the
real handlers. Add a control with every fix, so an overcorrection shows. Never write a case that rewards routing work
around a model's safety refusal.

CI runs only the unit tests here (`*.test.ts`). The eval calls paid models, so CI never runs it.

## Limits

- Codex gets prior turns as text, since it cannot resume an invented session.
- The fake's pictures are stand-ins (`rasterFrame`): footage is grey, a solid its colour, a title a light box around its
  position. `title_check` rows, sheets, PSD layers, alpha trims and gamut figures come from those, not from a look: they
  grade what the agent does with a result, never the render. `open_project_in_editor` makes reads report an editor
  (`propose_title` then stores a proposal); edits still apply headless, with no History.
- Harnesses change: Claude Code 2.1 cuts server instructions and each description at 4096 characters and defers MCP
  tools behind ToolSearch; Codex 0.163 sends no tool text until the model reaches for tools, and starts a turn without an
  optional server that is still starting, so the eval marks the stub `required`.
