# Project, session, API, configuration and client cleanup — round 2

Completed cleanup is recorded here and in the companion project-edit, project-media, project-transition and session round-2 reports. This report records decisions before editing against remote-integrated revision 87ebec9. No repository AGENTS.md exists; supplied host browser instructions apply. Commands: `pnpm exec vitest run packages/api packages/config packages/engine-client`; repository gates are `pnpm lint`, `pnpm typecheck`, `pnpm test`.

## API: packages/api/test/api.test.ts

| Original test | Disposition | Detected failure, remaining owner and rationale |
| --- | --- | --- |
| covers every M1 route of ARCHITECTURE §9.2 | DELETE | Declaration inventory cannot prove route handling; real engine route tests and typed client wire tests own routing. |
| builds paths and classifies engine prefixes | KEEP | Encodes spaces in path segments, rejects missing parameters, keeps engine URLs separate from SPA routes; ARCHITECTURE §9.2 and §4.1. |
| shapes errors per S04:ENG-022 | DELETE | Duplicates engine unit HTTP error mapping and client error decoding; no unique observable failure. |
| parses events and ignores unknown types | REWRITE | Remove event-name inventory assertion; retain known payload validation and malformed/unknown event rejection required by additive NDJSON protocol. |
| validates jobs and capabilities | DELETE | Positive fixture field echo and enum example duplicate actual jobs/capabilities route validation; no unique protocol edge. |
| round-trips a real envelope, export request and transaction result | DELETE | Same-version production-built fixtures and success/field echoes prove little; engine project/export/agent integration and project storage tests own these behaviors. |

Six-bar justification for path test: (1) documented HTTP path and SPA ownership contract; (2) broken escaping reaches the wrong resource and prefix confusion serves HTML to API clients; (3) literal independently written paths and booleans; (4) public buildPath/isEnginePath; (5) internal route and algorithm refactors preserve outcomes; (6) lowest path builder/classifier owner, uniquely covers space encoding, missing args and /apis near miss. Production callers: engine-client/client.ts and apps/engine/src/server.ts. Risk low; no route implementation changes.

Six-bar justification for event rewrite: (1) ARCHITECTURE §9.2 additive typed events; (2) unknown or malformed events reaching consumers can break updates; (3) fixed wire envelopes with literal expected type/null; (4) public parseEvent; (5) schema representation can change; (6) lowest payload decoder, stream tests own chunking/reconnection instead. Caller: engine-client/events.ts. Risk low; only declaration assertion removed.

## Configuration: packages/config/test/config.test.ts

| Original test | Disposition | Detected failure and stronger owner |
| --- | --- | --- |
| reads flags in both forms | DELETE | Extra parser layer duplicates appdir resolution; move equals syntax into existing precedence test. |
| resolves appdir with argv > env > default | REWRITE | Exercise --appdir=value in precedence case, retain env/default/relative-path behavior. |
| resolves port | KEEP | Default 47900, random port 0, env override and malformed port rejection. |
| parses truthy env values | DELETE | Trivial helper examples lack independently specified exact truthiness contract; engine startup owns dev-mode behavior. |
| lays out the appdir per ARCHITECTURE §4.3 | KEEP | Persistent project, media, journal and cache path compatibility. |
| locates the desktop appdir and parses runtime files | KEEP | Desktop/MCP discovery path and token validation. |

Full six-bar retention rationale (each row is a separate retained test):

| Test | 1 Independent contract | 2 Visible failure | 3 Independent oracle | 4 Stable seam | 5 Refactor survives | 6 Lowest unique owner |
| --- | --- | --- | --- | --- | --- | --- |
| appdir precedence (rewrite) | S04 ENG-010; ARCHITECTURE §4.3 CLI/environment | Projects saved in wrong directory | Literal directories, standard path resolution | resolveAppdir public config API | No private collaborator calls | Exact precedence/relative config resolution; startup tests do not enumerate precedence |
| port | D-07, desktop --port 0, JASPER_PORT config | Engine cannot bind/discover | Literal standard ports and invalid text | resolvePort | Parsing strategy irrelevant | Unique config input boundary |
| appdir layout | ARCHITECTURE §4.3 disk layout | Existing projects/cache cannot be found | Literal documented relative names joined using Node path | appdirPaths | Internal identifiers may change | Lowest persistence path ABI; integrations consume same helper so cannot independently catch renaming |
| desktop/runtime | ARCHITECTURE §11 MCP discovery and §4.3 | Tool misses running desktop or trusts malformed token | Literal OS paths, token and rejection values | desktopAppdir / parseEngineRuntime | Runtime parser may be replaced | Lowest shared discovery-file ABI |

Production callers: apps/engine CLI/index/services, apps/desktop main process and apps/mcp discovery/CLI. All retained config risk low; no production config change or removed API.

## Engine client: packages/engine-client/test/client.test.ts

| Original test | Disposition | Contract and recognizable failure |
| --- | --- | --- |
| calls typed routes with relative URLs and parses responses | KEEP | ARCHITECTURE §4.1/9.2: same-origin typed HTTP requests; wrong query/path or schema rejects valid engine response. |
| sends If-Match, JSON bodies and bearer tokens | KEEP | S01 PER-025 + S04 ENG-020: absent revision/auth loses concurrency protection or access. |
| maps error shapes, 501 stubs, invalid responses and API mismatches | KEEP | S04 ENG-022/024: callers receive machine-readable failures and cannot use incompatible engine. |
| builds media and output URLs | KEEP | S04 MS-001 and ARCHITECTURE §8/9.2: media element URLs must address the documented binary endpoints. |
| uploads in chunks, resumes on offset mismatch and completes | KEEP | S04 IN-005: client must slice original bytes at server offset and finish; wrong resume corrupts upload. |
| aborts the upload session when cancelled | REWRITE | Assert AbortError instead of any truthy rejection; DELETE cleanup URL remains protocol assertion. |
| parses events split across chunks, reconnects with backoff and resumes with since | KEEP | S04 ENG-023: split NDJSON and resume cursor must survive disconnect. |
| reconnects when heartbeats stop and caps the backoff at 30 s | REWRITE | Exercise production heartbeat timeout using fake time; remove test-only stream options. |

Full six-bar justification applies individually to each client row: (1) exact independent spec references and failure listed above; (2) listed caller-visible outcome fails the test; (3) hand-written HTTP responses/expected wire URLs, statuses, byte offsets and backoff values, never imported expectations; (4) public EngineClient methods at the HTTP transport boundary; (5) no private method shape assertions, internal routing/stream/upload code may change; (6) these are the lowest client owner of outgoing serialization, response rejection, element URLs, chunk slicing and reconnect timers respectively. Engine server tests own the other protocol direction and do not test this client. The fake transport returns wire fixtures; it does not implement client parsing, chunk slicing, authentication or reconnect behavior. Production callers: apps/web engine/client, import/media/jobs flows, apps/mcp engine link and packages/session EngineProjectStore. Risk low: timing stays at existing defaults; no production behavior changes.

Dead support/seams: remove unused event-stream timer/backoff/heartbeat injection options (no production callers; only heartbeat test shortened time). Global fake timers exercise the real defaults. Retain fetch injection because production public client transport is a stable SDK seam used by adapters. Validation results appended after edits.

Validation: API/config/client focused run passed 3 files, 14 tests. Biome checked 32 API/config/client/session files and formatted edited files successfully. Scoped diff whitespace inspection passed.

The duplicate scoped package typecheck was stopped at the coordinator's request once the full repository typecheck started; config and API had passed; engine-client was interrupted by SIGTERM, not a compiler error. Full gate results are recorded by the coordinator.

Final scoped review: packages/project, packages/session, packages/api, packages/config and packages/engine-client changed 45 code/test files, with test/support LOC net −1,541 (391 added, 1,932 removed). Each retained/deleted/rewritten project test is in the companion project-edit, project-remote, project-media or project-transition ledger. Focused retained contracts all validated: project edit/remote 196 cases; project transition/process 56; project media 160; session 31; API/config/client 14. The unchanged colour performance budget initially missed under concurrent host load and passed the isolated sequential rerun; no threshold was weakened. No production behavior fix was necessary.

Production seams removed: requiresApproval wrapper; isIsotropicResize export; pchipSlopes, hueRotateMatrix, saturateMatrix, mulMat3x3, whiteBalanceGains, wheelDirection and Mat3x3 exports; event-stream timer/backoff configuration used only by tests; unused autosave timer/delay/clock injection; MemoryProjectStore save/view counters; EngineProjectStore sleep injection. Support removed: duplicated template-load fixture helper, React smoke component, unused fake CRUD/list/view/version endpoints and mathematical reference helpers identified in companion ledgers.

Final follow-up: EngineProjectStore also dropped unused ids/clock/session-id/lifecycle/fetch injection options, and its internal keepalive helper became private. Existing token-mode pagehide regression now uses restored global browser APIs; 10/10 focused tests pass. The session ledger records pre-edit caller evidence and why storage metadata options remain. Earlier LOC totals describe the initial cleanup and exclude this additional removal.
