# Performance investigation

The investigation starts at commit `8b4c8936`. Each implementation has its own
repeatable benchmark and evidence note; the integrated gate is recorded below.
No document schema, persistence format or editing API change is intended.

## Critical paths

- Home and project opening: download and evaluate the SPA, open/validate a
  project, resolve media status, mount the editor and its Project panel.
- Interactive editing: select/deselect linked clips, search the timeline,
  sort project items, execute undoable commands and publish session changes.
- Playback and scrubbing: derive render snapshots, mount visible compositions,
  decode media and resample audio to the output rate.
- Background engine work: look up active derivative jobs, generate media
  derivatives, render exports and persist project state.

The existing scale, Chrome trace, bundle-recovery and audio-oracle tools are
used alongside small standalone benchmarks of the affected production calls.
The workers use separate branches/worktrees; timings must record host load
because builds and tests share the machine.

## Ranked opportunities before implementation

These are expected effects from source inspection, not measured speed claims.
Only candidates confirmed by before/after measurements will be integrated.

1. **Timeline Find:** source-name matching scans project items for every clip.
   A per-search lookup should remove the clips × items traversal on large bins,
   preserving first matching item names and search ordering.
2. **Project sorting:** `localeCompare` options are supplied for each comparison.
   A reusable `Intl.Collator` should reduce sort setup work while retaining the
   same locale, numeric ordering and tie behavior.
3. **Audio resampling:** coefficient tables are rebuilt for each short buffer.
   Bounded reuse should cut repeated scrubbing setup while retaining every
   convolution operation and exact output samples.
4. **Media status:** each status lookup clones/sorts all active jobs before
   selecting a handful of derivative keys. Filtering before cloning should cut
   opening/import overhead without weakening validation or changing readiness.
5. **Bulk deselection:** removal checks every selected ID against an array of
   removed IDs. Set membership should remove quadratic work while retaining
   order, domain behavior and linked selection rules.

A sixth investigation checks whether the catch-all vendor chunk pulls optional
dependencies into Home. It will proceed only if the emitted graph and browser
requests confirm a worthwhile, safe reduction.

## Measured results

Measured on Linux x64, AMD EPYC-Genoa, eight logical CPUs, Node 22.23.4 and
pnpm 10.34.5. This is a shared host: each linked note records its load and raw
samples. Function benchmarks alternate actual baseline/current implementations
on identical inputs in one process and assert equal results. Browser bundle
measurements alternate fresh authenticated Chrome 153 contexts. These figures
describe their particular workloads, not whole-editor speedups.

| Workload | Before | After | Evidence and reproduction |
|---|---:|---:|---|
| Find Source Name, 5,000 clips / 2,000 media | 1,165.56 ms | 6.72 ms | [Find](perf-model-hunt.md) |
| Project Name sort, 2,000 items (complete row derivation) | 95.25 ms | 15.38 ms | [Project sorting](perf-web-hunt.md) |
| Remove half of 10,000 selected IDs | 104.98 ms | 0.66 ms | [Selection](perf-session-hunt.md) |
| Expand 5,000 selected clips across 200 sequences | 137.59 ms | 26.89 ms | [Selection](perf-session-hunt.md) |
| Repeated 256-sample stereo resample, 44.1 to 48 kHz | 0.5592 ms | 0.0831 ms | [Resampling](perf-render-hunt.md) |
| Status of 500 media / 3,000 active jobs, concurrency 16 | 7,173.32 ms | 202.03 ms | [Media status](perf-engine-hunt.md) |
| Initial JavaScript, gzip with the same Node settings | 3,379,494 bytes | 2,511,084 bytes | [Bundle](perf-bundle-hunt.md) |

The integrated audio and media-status comparisons were rerun against the original
git source and retained identical samples/statuses and comparable gains.
The fully integrated web build measured 7,982,377 initial raw JavaScript bytes /
2,511,347 gzip bytes in eleven requests; the table isolates the bundle change
before the other optimizations' small source changes were integrated.

The resampler retains up to eight tables / 16 MiB per module instance. Cold calls
and continually changing ratios still build tables. Find uses temporary O(items)
storage per search; a single early source match can be cheaper with the old scan.
The bundle change removes optional code from the critical graph; its service
worker downloads that code after window load for offline availability, so total
background transfer is approximately unchanged. No end-to-end startup, playback
or export speedup is claimed. No API, editing behavior, document format or output
quality changed.

## Integration verification

Baseline lint and build passed. Baseline typecheck failed on recursive MCP test
schema inference; a typed recursive JSON schema preserves its runtime validation
and fixes that error, with property coverage. Baseline test probing also exposed
root permission bypass and a canvas fixture issue. The permission test passes
unchanged with DAC override capabilities dropped. The [canvas probe note](perf-capture-probe.md)
documents the fixture correction, retained exact pixel checks, shim-removal
control and older-browser limitation. The initial baseline test probe was stopped
after identifying these blockers; it is not reported as a passing suite.

The complete integrated gate and browser validation are recorded below when they
finish. The final test command uses `JASPER_REQUIRE_ORACLES=1`, Chrome 153 and
`setpriv --bounding-set=-dac_override,-dac_read_search pnpm test --maxWorkers=2`.

- `pnpm lint`: passed, with the same two existing optional-chain warnings as the
  baseline; token, animation and layer checks passed.
- `pnpm typecheck`: passed for every workspace package.
- `pnpm build` and `pnpm --filter @jasper/engine build:remotion`: passed.
- `pnpm perf --sections micro --label perf-hunt-integrated`: passed, including
  all eleven 200-sequence / 5,000-clip scale budgets (load factor 1).
- Browser integration: `pnpm e2e smoke.spec.ts bundle-loading.spec.ts pwa.spec.ts
  expressions.spec.ts imports.spec.ts audio-mix.spec.ts`: 12 passed, one skipped.
  The run set `E2E_PORT=49630` and `E2E_SKIP_BUILD=1` after the root production
  builds and Remotion bundle had just completed from the integrated sources;
  fixture preparation and the LGPL binary guard still ran. It exercised offline
  optional imports, actual QuickJS evaluation and screenshots, expressions,
  import formats, live audio meters/voice-over, linked editing/undo, native
  export and Remotion title export.
- A running-app check generated a 2,000-item project through the existing
  performance fixture/harness, clicked Name and Frame Rate in both directions,
  asserted all 77 visible row names against `projectRows` and inspected the four
  screenshots. No page errors occurred.

`pnpm mg:build` explicitly skipped because cargo is not installed. The native
motion-graphics E2E case therefore skipped; native Rust behavior was not tested.
The full Playwright catalogue, packaged desktop suites and opt-in extended
fuzz/render suites were not run. The default workspace suite, selected browser
tests and paired audio samples cover the changed paths; no GL shader or export
algorithm changed.
