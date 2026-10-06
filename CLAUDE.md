# JasperEditor: instructions for agents

JasperEditor is a Premiere-style, agent-drivable video editor: a pnpm TypeScript monorepo with a React
SPA (`apps/web`), a local Node engine (`apps/engine`), an MCP server (`apps/mcp`, `jasper-mcp`), an
Electron shell (`apps/desktop`), the pure project model (`packages/project`), Remotion compositions
(`packages/compositions`) and a Rust motion-graphics renderer (`native/mg`). Web, PWA and desktop load the
same SPA and talk to the same engine.

**Read [`AGENTS.md`](AGENTS.md) first. Its rules override everything here**: never crash or lose work;
never open `.reference/` or `editor-starter.zip`; LGPL-only FFmpeg; every asset licensed and attributed;
ported code recorded in `licenses/ported/`; export never silently drops a feature; no stubs claimed as done.

## Start every session here

1. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): layers, the decision log (§2.1), dependency rules
   (§3.1), the engine, the export planner, MCP. It wins over the specs in `docs/specs/`.
2. [`docs/gaps.md`](docs/gaps.md): the honest assessment against Premiere Pro and the workstreams, each
   with a "done when". [`docs/parity.md`](docs/parity.md) is the feature checklist behind it. Prefer
   closing a gap in a feature marked done over adding a new one.
3. The wp-note of the area you touch (`docs/wp-notes/`), the spec it cites, and the package's tests.
   Effects and transitions: [`docs/wp-notes/fx-transition-framework.md`](docs/wp-notes/fx-transition-framework.md).
   Project files, migrations, recovery: [`docs/project-files.md`](docs/project-files.md).
4. **Fidelity to Premiere and After Effects comes from research, not measurement.** There is no capture harness
   and no requirement to compare against Adobe software. Read Adobe's documented behaviour (helpx.adobe.com
   guides, effect and parameter references, shortcut lists, release notes), published formulas and the
   EffectCraft/FilmCraft notes; match names, ranges, defaults, units and visible behaviour, or do better where
   Adobe is clearly worse; cite the sources in your wp-note, and say so where behaviour is undocumented and you
   chose the most plausible one.
5. Then work autonomously. Make the decisions you can make yourself (see "Ask a human only about…"),
   and record them in your wp-note.

## The gate

`pnpm verify` = `pnpm lint && pnpm typecheck && pnpm test && pnpm build`. It must pass before you
merge. `pnpm lint` runs Biome plus our own checks:

| Check | Fails when |
|---|---|
| `scripts/check-tokens.mjs` | colour literals or raw palette classes in UI code (design tokens only) |
| `scripts/check-anime.mjs` | anime.js used outside its seek-driven rules (S11:ANM-006) |
| `scripts/check-layers.mjs` | a package imports something its layer may not ([ARCHITECTURE](docs/ARCHITECTURE.md) §3.1) |
| `scripts/check-assets.mjs` | an asset has no `<file>.attribution` sidecar or `ATTRIBUTION.md` row ([AGENTS.md](AGENTS.md) §3) |

`pnpm notices --check` fails when `THIRD_PARTY_NOTICES.md` (packages and `licenses/ported/*.md`) is stale;
run `pnpm notices` and commit the result. While developing on a shared machine, run targeted tests
(`pnpm vitest run <files> --maxWorkers=2`, `pnpm --filter <pkg> typecheck`) and the full gate when merging.

## Running and seeing the app (headless)

Look at the result of UI work; a passing unit test is not a screenshot.

- **Dev stack on your own ports** (several agents share the machine; pick a free `BASE`):
  ```bash
  JASPER_APPDIR=$PWD/.stage JASPER_DEV=1 JASPER_DEV_WEB_PORT=$((BASE+2)) \
    pnpm exec tsx apps/engine/src/cli.ts --port $((BASE+1))                       # engine
  JASPER_ENGINE_URL=http://127.0.0.1:$((BASE+1)) \
    pnpm --filter @jasper/web exec vite --host 127.0.0.1 --port $((BASE+2)) --strictPort   # web
  ```
  `pnpm dev` does the same on 47900/5173. `pnpm fixtures` makes the test media in `fixtures/media/`.
- **Built stack** (what the E2E suite uses): `pnpm build`, then `E2E_PORT=<port> node e2e/serve.mjs`
  serves the built engine and web app on one port with a throwaway appdir.
- **Screenshots and clicks:** a Playwright spec of your own (`E2E_PORT=<port> E2E_SKIP_BUILD=1
  pnpm exec playwright test e2e/<yours>.spec.ts`) or a browser automation tool pointed at the web URL.
  In dev builds and Electron (or with `localStorage['jasper:agent-bridge'] = '1'`) the agent bridge exposes
  the open session as `window.jasper` (`query`, `transact`) for scripted checks.
- **Through MCP** (no browser needed): the repo's [`.mcp.json`](.mcp.json) registers `jasper-mcp` from
  source with `--start-engine --appdir .stage`, so Claude Code in this checkout can call `engine_status`,
  `create_project`, `import_media`, `apply_commands`, `render_frame` (returns a PNG you can look at),
  `start_export` + `wait_for_job`, and `describe_commands` for the whole command catalogue. It uses a
  running engine on the `.stage` appdir if there is one (`pnpm dev`), else it starts a headless one
  (needs `pnpm --filter @jasper/engine build` once). The tools are listed in `README.md`.
- **Plain HTTP:** `GET /api/agent/schema`, `POST /api/agent/query`, `POST /api/agent/tx` on the engine
  (README "HTTP API underneath").
- Check exports by extracting frames (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png`) and looking at them.

## Parallel agents

- Each agent works in its own git worktree under `.claude/worktrees/<name>` on its own branch
  (`git worktree add .claude/worktrees/<name> -b feat/<name>`). Never edit another agent's worktree or
  the main checkout, never push, never rewrite history, and never use `git stash` (the stash is shared
  between worktrees): make WIP commits instead.
- Use your own ports and your own `JASPER_APPDIR`. Kill only processes you started.
- Merge the integration branch into yours, resolve conflicts keeping **both** sides' features and tests,
  run the gate, then fast-forward the integration branch. Never weaken someone else's test to get green.
- Schema changes from parallel work: add fields as optional with read-time defaults and update
  `repairDocument`; one integrator bumps the schema version ([docs/project-files.md](docs/project-files.md)).

## Definition of Done

A feature is done when, wherever it applies:

- [ ] the model and zod schema carry it, with invariants and `repairDocument` updated;
- [ ] every edit is an undoable command in `packages/project` (so agents get it through
      `describe_commands` / `apply_commands`), with tests including undo/redo and refusals;
- [ ] the UI is wired: panel controls, menus, context menus, Premiere-default shortcuts with no keymap
      conflicts (the keymap tests check this);
- [ ] the Program monitor previews it, and every export path renders it or the planner refuses with a
      named blocker (AGENTS.md §4);
- [ ] agents can drive it: MCP tools in `apps/mcp/src/tools/<area>.ts`, with the README tool list, the
      guide resource and tool docs updated;
- [ ] tests: unit, property/fuzz where inputs are untrusted, GL tests for shaders, oracle tests against
      ffmpeg or a standard where one exists;
- [ ] you ran it in the real app (preview and export) and looked at the frames;
- [ ] new assets have sidecars, ported code has a `licenses/ported/` record;
- [ ] `pnpm verify` passes; the wp-note (design, usage, verified behaviour, limits) is written.

### Reporting progress honestly

- Say how every number was obtained: **measured** (a test, a benchmark, a frame diff you ran, with the
  command) or **estimated** (≈, with what it's based on).
- Count an approximation, a stub or a partly wired setting as partial, never as done.
- Record known bugs and limitations in the wp-note and in `docs/gaps.md`, not only what works.
- Don't raise a percentage in `docs/parity.md` or `docs/gaps.md` without evidence a reviewer can rerun.
- Benchmarks state the machine, the load and before/after on the same build.

## Ask a human only about…

Decide everything else yourself and write the decision down. Ask only about:

- a licence outside the allowlist in AGENTS.md §2.5 and §3.2, or any doubt about an asset's licence;
- spending money (paid APIs, services, hardware);
- publishing, pushing, releasing or signing anything;
- personal data or credentials;
- destructive operations on shared state (other branches, other worktrees, history rewrites,
  deleting user projects);
- anything AGENTS.md leaves unclear ("when in doubt, leave it out").
