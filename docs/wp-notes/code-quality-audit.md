# Code quality audit

The audit starts from `12049d8e` and covers the tracked source, tests, scripts, package contracts,
and native renderer. Nineteen parallel reviewers inspected separate areas or performed independent
cross-area reviews. Findings were implemented when caller research, owning schemas or installed
dependency declarations, and tests supported the change. The purchased reference archive was excluded.

## Assessment

The largest maintainability problems were repeated internal contracts, casts over values whose types
already existed, dependency cycles through feature handlers, and duplicated asynchronous lifecycles.
Some apparent simplifications exposed correctness defects: swallowed persistence failures were treated
as successful saves, worker shutdown left promises pending, and malformed input could escape error
boundaries. These defects need behavioral tests; removing syntax alone would not address them.

Untrusted input remains `unknown` until validated. Shipped project migrations, supported old project
representations, capability checks, cancellation/cleanup boundaries, and alternate exact rendering
paths remain necessary. Removing them would weaken the project's recovery and compatibility contracts.
Explicit `any` in source, tests, and scripts is now subject to a lint gate; runtime module cycles are checked
separately from erased type imports.

## Area assessments

Each report records research, recommendations, changes, retained safeguards, and verification details.

| Area | Report |
| --- | --- |
| Project commands | [Commands](code-audit-project-commands.md) |
| Project model, parsers, and shared math | [Project model](code-audit-project-model.md) |
| Effect and property registries | [Registries](code-audit-project-registry.md) |
| Engine routes, persistence, jobs, and events | [Engine core](code-audit-engine-core.md) |
| Export and render workers | [Engine export](code-audit-engine-export.md) |
| Media, processing, tracking, and imports | [Engine media](code-audit-engine-media.md) |
| Editor panels | [Web panels](code-audit-web-panels.md) |
| Editor shell and commands | [Web shell](code-audit-web-shell.md) |
| Editor feature modules | [Web features](code-audit-web-features.md) |
| Preview and composition rendering | [Compositions](code-audit-compositions.md) |
| Audio DSP and animation | [Audio and animation](code-audit-audio-animation.md) |
| Timeline interchange and expressions | [Interchange and expressions](code-audit-interchange-expressions.md) |
| MCP tools and CLI | [MCP](code-audit-mcp.md) |
| Shared API and engine client | [Contracts](code-audit-contracts.md) |
| Sessions, persistence, and UI primitives | [Session and UI](code-audit-session-ui.md) |
| Desktop, configuration, and Rust | [Desktop and native](code-audit-desktop-native.md) |
| Scripts, test infrastructure, and E2E contracts | [Tooling and tests](code-audit-tooling-tests.md) |
| Import graph and dependency enforcement | [Dependency cycles](code-audit-dependency-cycles.md) |
| Independent cross-area review | [Crosscut review](code-audit-crosscut-review.md) |

## Integration verification

The integration checkout used a frozen offline dependency installation. Checks ran on the shared Linux
host under substantial contention; elapsed times below are observations, not performance comparisons.

| Check | Measured result |
| --- | --- |
| `pnpm lint` | Passed: Biome checked 2,548 files; token, animation, package-layer/runtime-cycle, and asset checks passed. |
| Workspace and E2E typechecks | All 18 package scripts passed across serialized integration batches and focused final package reruns. `pnpm e2e:typecheck` also passed. |
| `pnpm build` | Passed for web, desktop, engine, and MCP. The web build transformed 3,630 modules. |
| `pnpm notices --check` | Passed: 150 packages and 31 ported-code records. |
| `pnpm i18n:check` | Passed: 8,615 strings. |
| LGPL FFmpeg check | Passed against the pinned `vendor/ffmpeg-lgpl/linux-x64` distribution. |
| Project-file browser tests | Three passed: crash recovery, lease recovery, and versions/Save As. Completed editor screenshots were inspected. |
| Full software-GL shader compilation | Passed with required oracles and one compile worker: 983 unique programs, including 20 custom-vertex programs and 17 library stress cases. |
| Native export regression | Passed all pixel, audio, frame-count, event, and HTTP-range assertions. An extracted output frame was inspected. |
| Import integration suite | All 11 tests passed with unchanged assertions and deadlines, reusing generated fixtures. |
| Upscale media oracle | Passed in 108.95 seconds with its original 600-second deadline: all frame-count, frame-rate, dimensions, codec, colour-space, and audio-hash assertions passed. |
| Project-store integration suite | All seven tests passed, including a real-engine check that malformed views produce a warning without altering project or view bytes. |
| Desktop folder selection | All 20 focused main/preload/web tests passed; native dialogs were mocked. |
| MCP typed response boundaries | All 21 focused tests passed. |

The production/script syntax inventory decreased explicit `any` nodes from 21 to zero, `unknown`
nodes from 2,955 to 2,320, and double assertions through `unknown` from 189 to 102. Its final sample
covered 1,743 files; the exact counting method and boundary caveats are in the crosscut report.
An additional source/test scan found 60 explicit `any` nodes in test fixtures; those were replaced with
schema-derived or concrete fixture types. A final TypeScript syntax-tree scan of all 2,467 tracked
TS/JS files under `apps`, `packages`, `scripts`, `native`, and `e2e` found zero explicit `any` nodes.
The lint prohibition now applies across source, tests, and scripts. All eight identified runtime
dependency cycles were removed.

The rendering checks caught two integration regressions: literalized shader template expressions and
a 3D shader chunk selected using a removed comment marker. The expressions were restored, and shader
composition now imports an explicit chunk. Regression cases failed before the fixes and passed after
them; the complete 983-program sweep and all eight 3D rendering cases passed. A separate real camera
overlay regression caught and fixed an accidental value coercion during type cleanup.

Browser persistence checks used the built app and packaged LGPL FFmpeg on an isolated port. Their
temporary harness allowed longer scheduling deadlines on this host without changing assertions.
The export completion test and schema-conversion test received longer functional deadlines after
unchanged assertions completed beyond their old deadlines. Performance budgets were not relaxed;
the remix performance assertion passed on an isolated rerun with its existing budget.

GitHub Actions could not start a job because the repository's Actions budget prevented further use.
The [baseline run](https://github.com/JasperRaccoon/JasperEditor/actions/runs/38086564112) contains that
annotation and executed no steps. Local verification is the evidence for this audit; no hosted CI pass
is claimed. macOS/Windows native dialogs, signing, and hardware-specific rendering were not exercised
on this Linux host.

An audit and passing tests do not establish universal correctness across every input, platform, or hardware
configuration. Platform and rendering limitations already documented in `docs/gaps.md` remain in force.
