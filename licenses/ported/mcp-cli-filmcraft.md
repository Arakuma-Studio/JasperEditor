# MCP conventions: strict arguments, annotations, export progress and cancellation (from FilmCraft)

- **Upstream:** https://github.com/storytold/filmcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** mcp-cli workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/automation/src/server.rs` (`unknown_arg`, annotations test) | `apps/mcp/src/strict.ts`, `packages/project/src/agent/strict.ts`, `apps/mcp/test/conventions.test.ts` | unknown arguments name themselves and the accepted ones; every tool has a title and the four hints, checked by a test (extended here to nested objects, union members, typo suggestions and agent commands) |
| `crates/automation/src/long_job.rs` | `apps/mcp/src/context.ts` (`progressReporter`, `waitJob`, `cancelJobAndWait`), `apps/engine/src/export/service.ts` (`copyNoOverwrite`) | progress at most every 100 ms and strictly increasing; `notifications/cancelled` cancels the job and the partial output is deleted |
| `apps/filmcraft-cli/src/args.rs` | `apps/mcp/src/jasper-cli.ts` (`kvArgs`) | `key=value` arguments parsed as JSON when they parse, dotted keys nest; `run` prints one JSON line per command and stops at the first failure unless `--keep-going` |

Notes: re-implemented in TypeScript on the MCP TypeScript SDK; FilmCraft's file-name matching for partial
outputs is replaced by the engine job queue's own partial registry (the exact files a job claimed).
