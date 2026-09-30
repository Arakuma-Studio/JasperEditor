# Wave 2 integration (dev)

Merge order: WP-2A, 2F, 2C, 2B, 2D, 2E, 2G, 2H (all `--no-ff`). `pnpm verify` passes. The gated suites
also pass: `MG_PARITY=1` after `pnpm mg:build`, and `REMOTION_E2E=1`.

## Wiring done at integration

- **Autosave:** each session has one autosaver. `runtime/save.ts` reuses `persistenceFor(session)` from
  ProjectLifecycle.
- **Shell services:** the shell's PanelServices are shared with the monitors (`setMonitorPanelServices`)
  and with the timeline (`TimelineEnvProvider`: services, toasts, dialogs).
- **Export mode:** WP-2E's `<ExportMode/>` is the shell's `export` mode view. It stays in sync with
  `exportMode`, and ProjectLifecycle skips its overlay while the shell claims the host.
- **Timeline drops:** the timeline accepts effect drops (applied to the clip under the pointer) and
  motion-template drops. OS file drops use the module-level ImportService.
- **Keyboard commands:**
  - `edit.clear` routes to project.deleteItems, timeline.clear or effectControls.removeEffect.
  - With the Source monitor focused, In/Out/Clear/Go-to commands act on the source item.
  - transport.prevEdit/nextEdit: only WP-2C's implementation remains.
- **Agent schema:** `implemented` is derived from `notImplemented()` stubs, not from the owner.
- **Engine:**
  - `services.events` is the broadcaster.
  - `services.agentStore` is an adapter over ProjectStoreFs and LeaseManager.
  - The MG capability provider and the master hook are registered with core services.
  - The lease route honours `takeOver`.
  - `fframesReason` is dropped when the renderer is ready.
- **Test fixtures:** `scripts/make-fixtures.mjs` uses a per-process partial name, so parallel test
  workers no longer corrupt the fixtures.

## TODO (not done at integration)

- MG render jobs still use WP-2G's own runner, so they are not visible in `/api/jobs` and cannot be
  cancelled over HTTP.
- `MgRenderStateContext` is exported, but the Program monitor does not provide it yet.
- The Program monitor does not accept effect or motion-template drops (only the timeline does).
- The header has no dirty/saving indicator and no Jobs badge yet. The hooks for them are
  `usePersistenceStatus` and `useJobsSummary`.
- The Agent panel still uses its module-level `agentPanelServices`. Agent commands look in
  `ctx.services` first, then fall back to it.
- `panel.focus.agent` is registered by both app.ts and agent.ts; the WP-2H version wins and delegates
  to `panel.open.agent`.
- WP-2C's edit-point navigation does not scroll the timeline to reveal the new playhead position
  (WP-2B's `seekReveal` did).
- The web build prints a warning that a chunk is larger than 500 kB.

## Status after WP-3I

Each item from the TODO list above, with its status:

- **MG jobs in `/api/jobs`: done.** `JobQueue.registerExternalSource` handles list/get/cancel/retry, and
  export masters are child jobs.
- **`MgRenderStateContext`: done.** The Program monitor provides it from live mg-render job events.
- **Program monitor drops: done.** It accepts effect drops (on the layer under the pointer) and motion-template
  drops.
- **Header: done.** It has a save status and a Jobs badge (from `useJobsSummary`).
- **Agent panel: done.** It uses the shell's PanelServices; the module registry stays as a fallback for
  tests.
- **`panel.focus.agent`: unchanged.** It is still registered twice, and the WP-2H version wins and delegates.
- **Edit-point navigation: done.** Every keyboard seek on the sequence now reveals the playhead in the timeline.
- **Chunk size: done.** Panels are code-split and `@jasper/project` has its own chunk. The entry chunk is
  377 kB, so the warning is gone.

See `docs/wp-notes/WP-3I.md` and `docs/M1-STATUS.md`.

