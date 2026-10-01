# wp-m3-cachegc — media cache registry and garbage collection

Branch `wp/m3-cachegc` (from `ebb01ed`). Spec: S04 §7.5 CA-003/CA-004 (updated), **CA-010…CA-019** (new);
S06 **CG-056** (new). User-facing: README "Media cache".

## Survey (before)

Every engine cache under the appdir, and how it was cleaned:

| Location | Writer | Cleanup before M3 |
|---|---|---|
| `cache/<fp>/{keyframes,poster,sprite,peaks}-*` | derivatives (M1) | none |
| `cache/<fp>/proxy-{720,540}-*` | derivatives | none |
| `cache/luts/*.cube` | colour extension (~1 MB per keyframed state) | none |
| `cache/warp/*.mov` | warp stage (tracking / keyframed Motion) | none |
| `cache/layers/<key>/` | layer bake | own 14-day pass, ignores projects |
| `mg/<key>/` | composition pre-renders (mg-bundles), fframes renders (M1 mg) | own 14-day pass for compositions only; fframes none |
| `mg/posters/<bundleHash>/` | Motion Templates posters | none |
| `renders/<jobId>/output.*` | every export **and every still / `render_frame`** | none (the real trailer appdir: 18 GB in 48 dirs) |
| `remotion/bundle/<hash>/` | Remotion dev bundles | keeps 3 newest; `.partial-<pid>` leftovers never removed |
| `cache/jasper-proc-bundle/` | processing remote setup | none |
| `tmp/layer-preview-*`, `tmp/mg-schemas-*` | layer-bake preview planning, mg schemas | only at engine start |
| temporary files (`*.partial`, `*.tmp`, `.tmp-<job>`) | all writers | none after a crash |

Not caches (reported in the usage, never cleaned here): `media/` (imported copies), `media/processed/` (processed
versions, project media), `mg-bundles/`, `models/`, `projects/`.

## What was built

| Req | Where | Notes |
|---|---|---|
| CA-010/011 | `apps/engine/src/cache/layout.ts`, `store.ts` | Kinds, path → entry mapping, appdir scan (entries + orphans), `engine/cache-index.json` (access times, ref sets, last report; debounced atomic writes), `engine/cache.json` settings (separate file: engine.json is rewritten by the processing store without a shared lock). |
| CA-012 | `cache/project-refs.ts`, `cache/service.ts` (`projectsInfo`, `setRefs`, `commitHolderRefs`) | Computed from saved documents (cached per revision): media fingerprints → derivatives/proxies, composition clips → preview + master render keys (same functions as the editor and the `mg` extension; unit-tested against `masterRequests` + `prerenderKey`), bundle hashes → posters. Recorded: `export:<pid>:<seq>`, `still:<pid>:<seq>` (everything the job pinned), `layer-preview:<pid>:<clip>`. |
| CA-013/014/015/018 | `cache/service.ts`, `routes/cache.ts` | `usage`, `clean(mode, kinds)`, settings; serialized passes; automatic passes at start-up (20 s), hourly, 60 s after render-type jobs (`JASPER_CACHE_AUTO_GC=0` or vitest disables the timers). |
| CA-016 | `NativePrepareContext.pin` (export service), colour/warp/mg extensions, `ExportService.pinInputs`, `tools/http.ts` serve hook, layer-bake adapter | Protection = pinned ∨ busy (owner adapter / active job's dedupe key or id) ∨ recent (2 min) ∨ open project (lease or agent-relay connection: read-only windows count) ∨ current Remotion bundle. |
| CA-017 | `removePaths`, `sweepOrphans` | rename → `.trash-*` → rm; put back on a failed rename; orphans after 1 h idle; trash at once; dead job scratch. |
| CA-004 | `DerivativeService.regenerateMissing`, `MediaService.status` | `GET /api/media/:key` re-queues missing automatic derivatives (what an editor asks when it opens a project). |
| CA-019 | `apps/mcp/src/tools/cache.ts` | `get_cache_usage`, `clean_cache {mode: unused\|all, kinds?}` (destructive hint); `CACHE_GUIDE`. |
| UI | `apps/web/src/cache/MediaCachePage.tsx`, `commands/cache.ts` | Edit ▸ Preferences ▸ Media Cache… (`cache.preferences`), page `media-cache`: usage bar, per-kind table with size/age limits, Clean Unused, Clean All (not in use)… with confirmation, automatic cleaning (on/off, age, automatic/custom total limit), Save; refreshes on `cache.cleaned`. |
| CG-056 | `apps/engine/src/color/extension.ts` | Content-addressed LUT files (sha256 of the `.cube` text), memo state key → file, pin before reuse/write. Output unchanged (text byte-identical to M2; tested). |

Also fixed (found while verifying the UI): every `Select` inside a dialog opened *behind* the dialog scrim
(`--pr-z-popover` 1000 < `--pr-z-dialog` 1100) — Theme, Label colors, Host key checking were unusable. New token
`--pr-z-dialog-popover: 1150`.

## Decisions

- **Which refs keep entries.** Saved-project refs are exact for derivatives and composition renders (computed from
  the document); for export-evaluated caches (LUTs, warp, bakes) the last export / still / preview of each scope
  is the reference — editing a grade and re-exporting releases the old states. Automatic cleaning never removes
  referenced entries, even over budget (the page says so); only Clean All does.
- **Export outputs are cache.** `renders/<jobId>` (download copies, stills of `render_frame`) are kind
  `exports`/`stills` with 7 / 1 day defaults. A path export (`destination.path`) has its own copy already.
- **LUT compaction.** Content hashing + memo; 17³ lattices change 10.5 % of 8-bit outputs (max 6) and were rejected
  (spec CG-056). gzip'd storage would need decompressing into the job's scratch for every export; not done.
- **Per-service GC passes.** layer-bake and mg-bundles keep their `gc()` (tests) but their timers only run without
  the core registry; layer-bake registers a `layers` adapter (its leases + its `removing` map so lookups wait).

## Verification

- Unit/integration: `apps/engine/test/cache.test.ts` (layout, scan, usage, Clean Unused / All with saved and open
  projects and the relay probe, age + per-kind + total LRU budgets, settings validation/persistence, lookup ↔ removal
  race ×20, failed rename keeps the entry, crash leftovers swept, refs survive restart and go with the project,
  document refs = export/editor render keys, CA-004 regeneration, **a real native export (keyframed grade + keyframed
  Motion/warp) while Clean All runs in a loop**: succeeds, 30 identical-table states → 1 LUT file byte-identical to the
  M2 text, refs recorded, same pictures on re-export, Clean Unused keeps / Clean All removes after the grace window).
  `apps/web/test/media-cache.test.tsx`, `apps/mcp/test/cache.test.ts`, `e2e/media-cache.spec.ts`.
- Real material: a copy of `MatsSmileTrailer/editor-appdata` (renders hard-linked). Before: 18.0 GB, of which
  17.9 GB unused export outputs and stills; derivatives/proxies all referenced by the 17 trailer projects. Clean
  Unused removed the 48 render dirs and kept 830 referenced entries. Trailer v6 + keyframed Lumetri on T01 (124
  frames) + graded, pushed-in T02 (warp), 0–330 exported natively twice: A without cleaning, B while Clean All /
  auto passes (1-byte LUT and warp budgets) ran 95 times and removed 830 entries meanwhile — both succeeded, the files
  have the same size and frames 0/60/123/200/329 are identical (mean |A−B| = 0.000). The ref set held 62 LUTs + 1
  warp layer; after an engine restart Clean Unused kept all 62 (0 missing). Opening v6 afterwards re-queued its
  derivatives (163 media cache files back within 40 s, 53 proxy jobs queued). Screenshots: `/tmp/cachegc-shots/`.

## Open / not done

- fframes (M1 `motion-graphic`) render keys are not computed from documents (age/LRU only, no saved-project ref).
- Cache location is shown but not movable (desktop "move cache" of CA-003).
- Per-kind "never" age (null) is API-only; the page uses empty = default.
- `engine/logs` and the job journal are not managed here.
