# process: guardrails, project-file hygiene, crash recovery and versions

Workstream `process` of the parity program (branch `feat/process`). Decisions D-36…D-39 in
[ARCHITECTURE](../ARCHITECTURE.md) §2.1; user-facing behaviour in [project-files.md](../project-files.md).

## What it delivers

| Area | Files | Notes |
|---|---|---|
| Rules | `AGENTS.md`, `CLAUDE.md` | AGENTS.md: never crash or lose work, the `.reference/` / `editor-starter.zip` ban, LGPL-only FFmpeg, asset licensing and attribution, ported-code records, export never silently drops a feature, no stubs claimed as done. CLAUDE.md: start from ARCHITECTURE + gaps, the gate, running and seeing the app headlessly (dev stack on own ports, built stack, MCP, `window.jasper`), worktrees, Definition of Done, honest progress, fidelity by research (brief §3b), the "ask a human only about" list |
| Clean-room wording | `README.md`, ARCHITECTURE §0, D-36, `.gitignore` comment | "All code is original" withdrawn; ports from permissive licences allowed with a `licenses/ported/` record |
| `.mcp.json` | repo root | `node --import tsx apps/mcp/src/cli.ts --start-engine --appdir .stage`: no build needed for the server; uses the `pnpm dev` engine or starts a headless one (needs the engine bundle). README updated (it said no root `.mcp.json` on purpose) |
| Layering | `scripts/check-layers.mjs` (+ test), ARCHITECTURE §3.1, D-37 | A `LAYERS` table: allowed workspace edges, test-only edges, forbidden externals per package. Checks package.json edges, bare `@jasper/*` imports (allowed, declared, exported subpath), deep relative imports leaving the package root, `packages/*` → `apps/*`, React only in `session/src/react`, Node built-ins out of browser layers, anime.js only in motion. Reuses `parseImports` from `check-anime.mjs` (now exported), which keeps the determinism rules. The real repo passes with no exceptions; `engine → mcp` is an explicit edge (the engine serves `/mcp`) |
| Assets | `scripts/check-assets.mjs` (+ test), 68 `.attribution` sidecars, `ATTRIBUTION.md`, D-38 | Tracked and new (not ignored) files by extension; sidecar keys, allowed licences, licence file exists, `added:` format, an index row, no orphan sidecars, nothing under `fixtures/media/`. Every message prints the exact sidecar and row to write |
| Ported notices | `scripts/third-party-notices.mjs` (+ tests), `licenses/ported/README.md`, `licenses/texts/{MIT,Apache-2.0}.txt`, `licenses/ported/process.md`, `apps/web/src/shell/licenses.tsx` | Every `licenses/ported/*.md` except the README goes into `THIRD_PARTY_NOTICES.md` between markers, with the texts of the licences the records name; incomplete records fail generation and `--check`. Help ▸ About ▸ Licenses gets a "Ported source code" section |
| Schema history | `packages/project/test/fixtures/schema-v{1..5}.jasper`, `schema-history.test.ts` | Hand-made from `migrations.ts`; every fixture loads without repairs; each shipped step is pinned to its exact changes (`STEP_CHANGES`), so editing a shipped migration fails |
| Schema backup | `apps/engine/src/projects/store.ts` | First save of a newer schema over an older file copies it to `project (schema vN backup).jasper`, once; listed as a version of kind `schema-backup`, openable as a copy |
| Versions | engine `version()` / `restoreVersion()`, routes `GET …/versions/:id`, `POST …/versions/:id/restore`; `EngineProjectStore.restoreVersion` (copy, S01:PER-001) and `revertToVersion` (in place); File ▸ Project Versions… | In place keeps the replaced state as a `before-restore` version and is refused while another session holds the lease |
| Crash recovery | engine `projects/recovery.ts` + routes; session `persistence/recovery.ts` (journal writer), `EditorSession.replaceDocument`; web `home/project-files.tsx`, `ProjectLifecycle` | AC-18 / S01:PER-021, below |
| File menu | `apps/web/src/commands/project-files.ts` | `app.saveAs`, `app.saveCopy`, `file.revert` (were menu-only), `file.projectVersions`, `file.recoverUnsaved` |
| MCP | `apps/mcp/src/tools/versions.ts`, `apps/mcp/test/{versions,readme-tools}.test.ts` | `list_project_versions`, `restore_project_version`, `save_project_copy`, `list_unsaved_changes`; README tool list fixed (it missed 8 tools) and now checked by a test |
| Docs | `docs/project-files.md`, `docs/gaps.md`, `docs/parity.md`, M1-STATUS / WP-2E correction | |

## Crash-recovery design

The browser holds the document; the engine holds the files. The journal therefore lives in the engine, written by
the session that holds the editing lease:

- the session writer (`createRecoveryJournal`) sends the committed document about 1 s after the last edit and at
  most every 5 s while edits continue, only while it holds the lease, with the labels of the unsaved History steps;
  a failed write backs off one interval; an engine without the routes (`NOT_IMPLEMENTED`) stops it;
- autosave catching up deletes the journal; a clean close deletes it unless changes are still unsaved;
  File ▸ Revert deletes it;
- **the lock is the lease**: the engine treats a journal as held while the engine process that wrote it is alive
  and (for itself) the writing session still holds the lease. A killed tab's lease expires after 30 s; a restarted
  engine knows no leases (a new `instance` id distinguishes a reused pid). Journals written by another live engine
  process on the same appdir are never touched;
- on open, unheld journals that differ from the saved project are offered; one equal to it is stale and removed;
- Recover = `EditorSession.replaceDocument` (one undoable History step that also bumps every entity revision so
  agents cannot fast-forward over it), then journal the new state, save, and delete the old journal.

Compared with FilmCraft (`docs/project-files.md`, its journal is a per-process snapshot under an OS file lock):
same snapshot-plus-session-file shape, same 1 s debounce, same Recover / Not Now / Discard choice, same "the
recovered state is journalled before the old journal goes". Better here: the prompt lists the unsaved changes by
name, recovery is an undoable step, it warns when the project was saved again after the crash, and agents can see
journals. Different by necessity: the lock is the editing lease (the editor is a browser tab, not the process
holding files), so after a crash within the 30 s lease the project opens read-only; **Take over editing** (or
waiting 30 s) then offers the recovery. Not done: FilmCraft's separate time-stamped auto-save ring next to the
project; here autosave writes the project itself and the 5-minute versions are the ring.

## Verified in the real app

Engine on 49001 (`/tmp/proc/appdir`) and Vite on 49002, Chrome via Playwright (`/tmp/proc/verify*.mjs`, not
committed):

1. A new project; 8 `marker.add` transactions through `window.jasper` 300 ms apart; the saved revision was still 0
   (autosave had not run) and no recovery candidate was listed while the session held the lease.
2. Chrome killed with SIGKILL. After 31 s the engine listed one candidate with 8 changes.
3. Reopening showed the prompt (screenshot: "JasperEditor closed before 'Crash test' was saved… 8 unsaved changes:
   Agent: Marker 0, …"). Recover → the timeline showed the 8 markers, the project was saved (revision 1, 8 markers)
   and no candidate was left.
4. Reload kept the project editable (no read-only banner): the lease is released on `pagehide`, which corrects
   `docs/M1-STATUS.md`.
5. File ▸ Project Versions… listed the auto-saved revision 0; File ▸ Save As… "Crash test v2" opened the new
   project (URL changed, both projects listed).
6. With everything saved, File ▸ Revert was disabled. Project Versions… ▸ Restore (confirmed) wrote revision 0
   back as revision 2 (0 markers) and kept the replaced state: versions `before-restore@1`, `auto@0`.
7. A project whose file was replaced by the schema v4 fixture opened, took one edit and autosaved: the file is now
   v5 and `project (schema v4 backup).jasper` holds the v4 original.

Playwright: `e2e/project-files.spec.ts` (built app): the recovery prompt for a journal left by a session that lost
its lease, Recover, Edit ▸ Undo of the recovery; reload stays editable; Revert disabled when saved; Project Versions
▸ Restore; Save As. Passed 6/6 with `--repeat-each=3`. While writing it, one run in about six showed a lease still
held 15 s after a full navigation to Home that followed the project's opening by a second or two; not reproduced
since, cause unknown (recorded in M1-STATUS).

## Historical tests added

This list records the original workstream, including tests removed by the later cleanup.

`scripts/check-layers.test.mjs` (8), `scripts/check-assets.test.mjs` (8), `scripts/third-party-notices.test.mjs`
(+4), `packages/project/test/schema-history.test.ts` (14), `apps/engine/test/recovery-versions.test.ts` (9),
`packages/session/test/persistence/recovery.test.ts` (5), `apps/web/test/project-files.test.tsx` (5),
`apps/web/test/third-party-notices.test.tsx` (+1), `apps/mcp/test/versions.test.ts` (2),
`apps/mcp/test/readme-tools.test.ts` (1), `e2e/project-files.spec.ts` (2).

## Limits and decisions

- Eleven committed screenshots and contact sheets showed photographs or video of unknown source (a portrait, a
  parrot, landscapes, a rover, a presenter); with no recorded licence they were removed (AGENTS.md §3.2, "when in
  doubt, leave it out") and listed in ATTRIBUTION.md for re-rendering over `pnpm fixtures` media.
- Original assets carry `LicenseRef-JasperEditor`: the repository has no public licence yet.
- Revert is enabled only while there are unsaved changes; with autosave that window is short, and Project
  Versions is the way further back (documented).
- The journal sends the whole document, not a list of transactions (S01:PER-021 says "transactions"): history
  entries are snapshots (D-05), and a snapshot cannot drift from what the user saw.
- The gaps/parity numbers describe `main` at 051cf53 and credit none of the in-flight workstreams, this one
  included; the integrator refreshes them.
