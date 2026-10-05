# Slop audit — 2026-10-05

Started from clean `main` at `87ebec9`, synchronized with `origin/main`. Parallel reviews covered every application and shared package, native motion graphics, fixtures, scripts, browser/desktop tests, root configuration, and active documentation. Historical audit/specification records and third-party assets were retained. The clean-room exclusions (`.reference/` and `editor-starter.zip`) were not read.

Changes below were checked against repository callers and existing behavior. Related edits with the same risk and verification are grouped. No dependency upgrades or product feature removals were intended.

## Change ledger

| Area and change | Why remove or simplify it | Risk and verification |
| --- | --- | --- |
| Project media sizing, clipboard frame rates, effect lookup | Duplicate implementations already existed as `mediaIntrinsicSize`, `fpsOf`, and `locateEffect`. | Rotation, rounding, traversal order: compared implementations and ran project command/clipboard/simplification tests. |
| Project render snapshots and color types | Duplicate intrinsic-box branches, audio/visual transition-field assembly, and an identical effect interface. | Geometry and omitted fields: existing snapshot, shape, composition, transition, and color tests; independent diff review. |
| Project text/clipping helpers | A one-use path wrapper, immediately invoked function, redundant cast, and identical switch branches added no behavior. | Clipping bounds and simplification identity: project suites and typechecks. |
| Project command inventory test | A stale literal list repeated the catalog instead of exercising commands. | Lost behavioral coverage: command execution, schema export, stub refusal, migration, and fuzz tests remain; 469 project tests passed. |
| Engine cache pins and startup state | Pin counts were incremented but never read/decremented; release removes the whole holder. Free-space state was used only during startup. | Pin lifetime and budget calculation: cache/location tests plus independent comparison of acquire/release paths. |
| Engine cache layout/reports and routes | Duplicate entry/report construction and an accessor guarding a required, initialized service. | Cache classification and startup order: cache/location/server tests; service construction and type contract reviewed. |
| Engine jobs, project paths, media helpers, and barrels | Single-use forwarding wrappers, duplicate terminal-state lists, and re-exports without consumers. | Persistence, snapshots, scheduling, and imports: engine integration tests and typecheck; callers use concrete service modules. |
| Processing SHA-256 | Three identical streaming file hash implementations. | Digest/error behavior: shared implementation preserves stream events; model, processing, and CLI integrations exercise consumers. |
| Processing filters, derivative selection, SSH setup | Duplicate format strings and non-video branches; redundant directory preparation after `execOk`; repeated quoting implementation. | Exact FFmpeg arguments and remote setup: filter equivalence review and media/processing/remote tests. |
| Processing unused extension points | No filter implemented `outputSize`; stabilization callback injection and a smooth-path guard had no applicable caller/path. | Frame dimensions and stabilization: resizing frame steps remain; producer/caller search and processing tests. |
| Four color-range test cases | Inputs contained no scale filters, so the scale-option assertions had no values to check. | Range coverage: real conversion-string cases and decoded black/white integration matrix remain. |
| Engine rendering bookkeeping | `PreparedLayer.bake` was never read; recipe branching duplicated `variantFrames`; encoder pair matching already proves argument length. | Render frames and codec arguments: export, warp, layer-bake, page-pool, and LGPL tests. |
| Motion bundle internals | Unread service fields, an always-empty warning accumulator, and directory-entry metadata immediately superseded by `stat`. | Schema warnings, hashing, and polling: bundle tests; symlink-following behavior retained. |
| Rendering test scaffolding | Repeated pixel-comparison loops, an IIFE, a no-op type alias, and duplicate worst-frame calculation. | Numerical coverage: all pixel thresholds and assertions retained; worst-frame loop still propagates `NaN` through `Math.max`. |
| Composition color state | Reordered-effect IDs and error strings had no readers; LUT value already expresses pending/success/failure. | `undefined`/LUT/`null` semantics: direct state/cache checks, composition tests, and independent diff review. |
| Composition SVG/font dispatch | SVG wrapper repeated narrowing done by both callers; font matching duplicated `fontFaceFor`. | Template selection and fallback font choice: caller comparison, composition tests, and typecheck. |
| Web shell/agent APIs | Uncalled getters/methods, unsupplied options/callbacks/timer injection, and unreachable alternate title-bar rendering. | Defaults and lifecycle: repository callsite review, shell/agent/workspace tests, and web typecheck. |
| Web commands and shell copy | Duplicate shell/command lookups and aliases; internal work-package instructions appeared in product copy. | Command behavior: canonical terminal states, text presets, and original-media lookup retained; web tests. |
| Panel registry, formatting, and transition menus | Unused lookup APIs; repeated stream/frame calculations; duplicate alignment options. | Panel registration, timecodes, and menu order: panel, project, and transition-inspector tests. |
| Timeline track/gesture helpers | Repeated existing track lookups and identical minimum-index loops. | Missing tracks/clips, kind filtering, and movement bounds: timeline/gesture tests. |
| Program monitor scaffolding | Persistence flag never disabled; clock had one implementation; unsubscribe array held one entry; resize hook already existed. | Playback, persistence, and resize lifecycle: monitor, transport, watchdog, and reverse-playback tests. |
| Program snap/ruler data | Callback never supplied; snap source IDs and letterbox token never read. | Snapping bounds and overlay behavior: geometry and monitor tests. |
| Web feature wrappers | Processing aliases only forwarded project helpers; clipboard conversion and pass-through helpers repeated existing behavior; layer-bake attachment hook had one caller. | Clipboard mapping and source timing: clipboard, processing, and runtime tests. |
| Web runtime bookkeeping | Tracking getter, shape drag position, MG active-host set, and layer-bake status payloads had no readers. | Host limits, notifications, request deduplication, failure suppression: runtime/live-tracking/shape tests. Membership remains a set. |
| Shared session/UI/API helpers | Unused committed-document/lease/dialog/recent-color accessors, never-rendered progress/effect-badge components, and unused header/schema aliases. | Hidden imports: tracked-source usage scans, shared-package tests/typechecks, web build. Architecture-promised hooks/primitives retained. |
| MCP/desktop internals | Unused export surface, duplicate track iteration, one-use tracking wrapper, unread clip ID, and unused registry injection. | Protocol and IPC contracts: MCP/desktop typechecks, builds, security and integration tests. Public MCP entry points retained. |
| MCP test helpers | Five environment builders and three polling loops were identical. | Environment isolation and readiness: exact shared implementation; all assertions retained and integrations run on distinct ports. |
| Browser test helpers | Three identical transaction helpers, one-use history wrapper, and single-test serial/global-page lifecycle. | Page isolation and agent errors: existing browser suites and E2E typecheck; no scenarios/assertions removed. |
| Animation lint scanner | Unused imported-local names, split/join round trip, regex-covered special case, and declaration file without TypeScript consumers. | Detection coverage: 31 script tests; old/new scanner outputs matched on all 920 tracked JS/TS files; scanner CLI and E2E typecheck passed. |
| Private exports and stale comments across areas | Module-only declarations exposed misleading APIs; obsolete ownership/test references added no explanation. | Missed consumers: repository searches, package entry-point review, typechecks, builds, and tests. Boundary validation, worker ABI exports, documented APIs, and substantive comments retained. |

## Verification before remote integration

Initial parallel checks encountered severe host contention; final checks use bounded workers and command-line timeout overrides. Repository timeout values and numerical tolerances are unchanged.

The first aggregate Vitest run with the default fork pool emitted no test results and was cancelled as inconclusive. A diagnostic inspector attach also triggered a Node assertion in one worker. A single-file probe with the thread pool passed normally, so the aggregate retry uses `--pool=threads --maxWorkers=1 --testTimeout=120000 --hookTimeout=120000 --reporter=verbose`. These are validation-command settings only. After host load dropped, the same 16-test probe also passed with the default fork pool in 4.6 seconds.

- Workspace typechecks and E2E typecheck passed.
- Full lint passed: Biome, design-token checks, and animation import checks.
- Workspace build and the Remotion bundle build passed.
- Aggregate Vitest: 1,446 passed, one CPU-budget failure, and 32 opt-in skips across 166 files. The unchanged 22-test project color suite then passed in the default fork pool; the sole failed LUT-bake gate measured 25.38 ms against its original 30 ms ceiling (32.40 ms in the thread-pool aggregate). All 1,447 standard cases were therefore verified across the aggregate run and isolated retry.
- All 101 browser scenarios passed across the full run and an isolated retry: the full run passed 93, two file-chooser setup timeouts interrupted eight scenarios, and all 10 cases in the affected agent/color files then passed. Color preview parity was exact for both auto and WebGL paths.
- Packaged-like and development Electron smoke checks, all four desktop clipboard cases, native MG readiness, and forced Remotion fallback export passed.
- Native motion-graphics parity checks passed with `MG_PARITY=1`; the Rust workspace passed all eight tests.
- Opt-in rendering passed all 41 tests across nine suites with `REMOTION_E2E=1 MG_E2E=1`, covering the 29 rendering cases skipped in the aggregate run. Together with the two native parity cases, only the unavailable real-SSH case remained unverified.
- Independent review checked cache pin lifetime, processing dimensions/hash behavior, LUT pending/failure states, font fallback, intrinsic geometry, and SVG dispatch without finding a regression.

Remote commit `63efec9` arrived after this validation. Its integration is being reviewed separately because it changes production internals and prunes tests across the repository. No real SSH host or other operating-system environment was supplied. Historical records, compatibility guards, rendering thresholds, and meaningful regression assertions were retained.
