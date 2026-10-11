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
Explicit `any` in production source is now subject to a lint gate; runtime module cycles are checked
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

Integration checks and their measured outcomes will be recorded after all reviewed changes are combined.
An audit and passing tests do not establish universal correctness across every input, platform, or hardware
configuration. Platform and rendering limitations already documented in `docs/gaps.md` remain in force.
