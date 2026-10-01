# Engine and MCP test cleanup audit

This audit records the pre-edit test cases. **K** = keep, **R** = rewrite to the stated observable contract, **D** = delete. For every K/R item below, the cited specification, protocol, public API, or fixed fixture is bar 1; the stated failure is bar 2; the stated expected result is an oracle independent of the implementation (bar 3); the named route, SDK, service API, or external artifact is the stable seam (bar 4); only the observable result is asserted, so an implementation rename or internal restructuring preserves the test (bar 5); and the stated unique behavior identifies why this is the lowest stable owner rather than a duplicate (bar 6). The few direct service tests exercise clock, disk, queue, or protocol behavior that a higher route cannot control deterministically. Source: `docs/specs/01-project-model-and-state.md` (S01), `docs/specs/04-media-render-and-backend.md` (S04), `docs/ARCHITECTURE.md`, and the cited `docs/wp-notes` files. Risk for K/R is accidental loss of the named contract; risk for D is the stronger owner identified in each row. Validation: `pnpm exec vitest run apps/engine/test/<file>.test.ts`, engine typecheck, repo lint and test gates.

## Engine core, HTTP, and storage

### `apps/engine/test/unit.test.ts`

| Disposition and baseline test | Failure and independent oracle; stable seam and unique owner |
| --- | --- |
| K — `empty: file agrees with the vector` | Wrong empty-file fingerprint; fixed SHA-256 vector from independent Python calculation under S01:AST-003, through `fingerprintFile`; catches a boundary not covered by a media fixture. |
| K — `abc: file agrees with the vector` | Wrong small-file fingerprint; independent fixed digest, through `fingerprintFile`; unique nonempty short input. |
| K — `8 MiB (whole file): file agrees with the vector` | Incorrect first/last-window handling at the threshold; independent fixed digest, through `fingerprintFile`; unique threshold case. |
| K — `9 MiB (first+last 4 MiB): file agrees with the vector` | Wrong two-window fingerprint; independent fixed digest, through `fingerprintFile`; unique over-threshold case. |
| K — `media keys are mk_ + 24 hex of the fingerprint` | Invalid or unstable media identity; S01:AST-003 literal prefix/length and invalid input, through `mediaKeyFor`; no other owner checks exact key derivation. |
| D — `handles start-end, open-ended, suffix, clamping and invalid ranges` | Could detect byte-range parser mistakes, but `media.test.ts`'s HTTP Range/416/If-Range case owns the client-visible byte contract. `parseRange` had no non-test external caller; its test-only export was removed. Low risk. |
| K — `verifies path + expiry and rejects tampering` | Forged/expired signed media access; S04:MS-003 path and expiry rules provide literal true/false oracle through `UrlSigner`; the HTTP signed-media test cannot advance expiry and this is the lowest deterministic seam. |
| K — `assigns monotonic ids, replays since an id and filters by project` | Missed or leaked project events and unrecoverable ring overflow; S04:ENG-023 monotonic/replay/filter contract supplies expected IDs through exported `Broadcaster`; this is the lowest seam for bounded-ring `complete`, while `events.test.ts` owns socket transport. |
| K — `computes max-abs per channel and per window across chunk boundaries` | Incorrect audible waveform channels or chunk-boundary peaks; S04:WF-001 gives max-absolute/100-peaks-per-second semantics and hand-chosen PCM values, through the production peak reducer; derivative HTTP test checks file format, not numeric per-channel values. |
| D — `builds atempo chains within 0.5…100 per instance` | Asserted a private FFmpeg argument representation. `export.test.ts` now checks frame-coded video speed and a rendered 4× tone artifact for decoded duration, pulse timing and retained 1 kHz pitch; no caller uses the `atempoChain` export, so it was removed. |
| D — `parses -progress blocks` | Exercised a private parser shape; `jobs.test.ts` uses real FFmpeg progress during cancellation and `export.test.ts` observes finished artifacts. No non-test external caller needs the parser export, which was removed. Low risk for the UI-visible progress path because queue progress tests remain. |
| R — `reads rotation from the display matrix and legacy tags` → `reads legacy rotation tags when the display matrix is absent` | A legacy rotate tag must yield upright display dimensions under S04:PB-003. Fixed FFprobe-shaped metadata is supplied to production `probeFile`, with expected 270°/1080×1920 independent of the mapper; `media.test.ts` covers real display-matrix rotation, so this retains only the missing legacy case. |
| R — `detects VFR, kinds and browser playability` → `detects VFR and VP9 alpha metadata` | Wrong VFR badge or lost WebM alpha; S04:PB-002 and PX-001 define the numeric rate threshold and alpha outcome. Fixed FFprobe metadata enters `probeFile`; real media tests already own PNG/audio/ProRes classification, so those duplicate fixture cases were removed. |
| K — `maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths` | Wrong public error code or leaked local paths; S04:ENG-022/SC error and secrecy requirements define statuses/codes/absence of paths through a Fastify guarded reply. No other test drives all three OS-error branches. |
| K — `the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)` | A second dev stack cannot reach the engine, or a production host is trusted; WP-3I environment option and fixed ports define the expected host set via engine config. `server.test.ts` checks normal host rejection, not the custom environment mapping. |
| K — `resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)` | Relative packaged web assets fail to serve; WP-3I env path rule supplies expected absolute path through engine config. SPA route tests use an already absolute directory. |
| D — `the native export graph uses the chosen encoder` | Only scanned a private graph's FFmpeg argument list. `encoders.test.ts` owns D-13 codec selection and `export.test.ts` verifies encoded output codec. No unique behavior remained. |

`probeFile` is the real media-service entry point. Its fake FFmpeg adapter only supplies external JSON; it does not implement any classification being asserted. Test-only exports of `mapProbe`, `rotationOf`, `parseRational`, `streamHasAlpha`, and `browserDecodable`, and `FfStream` were removed after a non-test caller search found only same-file use. `Broadcaster.since().complete` was retained because `Broadcaster` is exported from the engine public entry point and the dropped-event indicator is documented.

### `apps/engine/test/server.test.ts`

All K/R rows below use the Fastify HTTP response or engine startup as the seam. S04:ENG-020/022, S04:SC-001, ARCHITECTURE §4.2/4.3/9.1, and `docs/wp-notes/wp-mcp.md` are independent sources. Explicit status/body/filesystem oracles survive route implementation refactors; each row owns a different externally observable condition.

| Disposition and baseline test | Caller-visible failure; oracle and unique owner |
| --- | --- |
| K — `GET /health returns ok with the API header` | Health client cannot identify API version; documented health body/header, unlike other route smoke tests. |
| D — `registers every route in the API contract` | Compared `ROUTES` declarations with Fastify registrations, a route inventory/change detector that can fail on harmless routing refactors. Functional route suites own endpoint behavior. No production seam was removed. |
| K — `rejects foreign Host headers (DNS-rebinding defense)` | Browser reaches local service via attacker Host; fixed 403/allowed loopback status, unique host defense. |
| K — `local token mode requires the bearer token or session cookie, except /health` | Protected data exposed or legitimate local session locked out; fixed 401/200 token-cookie statuses, unique general auth policy. |
| K — `serves the SPA with a fallback that never shadows engine paths` | Deep links fail or engine URLs return HTML; fixed HTTP content/status and reserved paths, unique navigation fallback. |
| K — `uses the ENG-022 error shape for bad requests and unknown routes` | API clients cannot classify failures; specified error code/status JSON, unique general error handler. |
| K — `rejects cross-origin requests (same-origin only, S04:SC-001)` | Cross-site page can mutate engine state; fixed forbidden/allowed Origin status, unique CSRF defense. |
| K — `refuses a non-loopback bind without a token (M1 is loopback only)` | Unauthenticated network exposure; specified startup refusal, unique bind policy. |
| D — `startEngine listens on a random port and prepares the appdir` | Generic start/health smoke duplicated the runtime-file startup test and MCP real-engine tests. No distinct behavior was specified or left unprotected. |
| K — `writes <appdir>/engine/runtime.json (0600) for local tools and removes it on stop` | Local tools cannot connect or token file leaks; specified path, contents, permissions, and deletion are independent, unique startup lifecycle. |
| R — `wipes tmp/ but keeps .gitkeep` | Stale temporary job files survive restart; ARCHITECTURE §4.3 defines wipe and `.gitkeep` retention, observed on disk. Removed the exact root-directory inventory, which merely tracked current implementation. |

### `apps/engine/test/events.test.ts`

All K/R tests here use actual NDJSON HTTP, capabilities HTTP, or font HTTP plus the service's public resolver. S04:ENG-023/RT-002/RT-004 and WP-2F are the independent sources. Fixed statuses, payload fields, and WOFF2 bytes form independent oracles; no test inspects source or collaborator call shape. Socket transport is this file's lowest owner, while `unit.test.ts` owns bounded ring math.

| Disposition and baseline test | Failure and unique oracle |
| --- | --- |
| K — `streams live events after an initial heartbeat, filtered by projectId, and resumes with ?since=` | Lost, reordered, or cross-project events; fixed published event sequence and monotonic IDs over real socket. |
| K — `rejects a malformed since` | Invalid resume cursor accepted; documented 400 `VALIDATION_FAILED` over HTTP. |
| K — `reports ffmpeg, native render, Remotion state and provider patches (WP-2G hook)` | Capability clients see incorrect availability or miss change events; schema, present FFmpeg, provider transition and license metadata assert S04:RT-002/004 and licensing response. Unique dynamic provider and capability route owner. |
| R — `serves the curated font catalog and immutable font files` | Font picker receives unusable Inter font or wrong fallback/unsafe path; WP-2F requires bundled WOFF2 service and Source Sans 3 fallback. Assert catalog-discovered URL returns WOFF2, immutable cache, fallback and path rejection. Removed the exact ten-family list, list position, internal filename and nearest-weight shape checks. |

### `apps/engine/test/jobs.test.ts`

All nine tests are **K**. S04:JB-011/012/013/014/020/030/040, S04:ENG-004, QA-007/008 specify scheduling, retry, cancellation and recovery. A `JobQueue` is the lowest stable service seam for controllable slots, runners, journaling and simulated crash; the cancellation HTTP case uses the public route and the real FFmpeg case uses actual processes. Each expected order, state, code, time bound, or journal result comes from those requirements rather than the queue implementation. These assertions survive changes to queue internals; each item below is a distinct failure mode.

| Baseline test | Caller-visible failure and independent oracle |
| --- | --- |
| `runs lanes in priority order within the CPU slots and dedupes by key` | Interactive work starves or duplicate work runs; specified priority order/slot bound/key identity. |
| `starts exports with at least half the slots and pauses the background lane meanwhile (JB-012/013)` | Export stalls behind background work; specified minimum slot reservation and pause. |
| `fails with a retryable error, keeps a log, and retries as a new job` | Caller cannot recover a transient job or sees false retryability; specified code/log/new ID and result. |
| `throttles job.updated to 4/s per job and always sends the final state (JB-040)` | Event flood or missing completion; fixed 4/s upper bound and terminal event. |
| `cancels a running ffmpeg job within 5 s with no child process left and removes partials` | Cancel leaves CPU process/output behind; real FFmpeg, 5 s requirement, no PIDs/partial file. |
| `cancels queued jobs immediately and cascades to child jobs` | Queued descendants run after parent cancellation; specified cancelled states. |
| `cancels over HTTP (POST /api/jobs/:id/cancel)` | API client cannot cancel/retry or sees cancelled job active; documented route statuses and job state. |
| `marks a running job interrupted after a crash, restores queued jobs and re-queues artifact jobs` | Restart loses jobs or retries export automatically; specified recovered states and exactly-once artifact work. |
| `graceful shutdown records running jobs as interrupted (S04:ENG-004)` | Shutdown leaves phantom running jobs; specified interrupted state persisted across restart. |

### `apps/engine/test/mcp.test.ts`

Both tests are **K**. `docs/wp-notes/wp-mcp.md` and MCP Streamable HTTP specify session/auth/tool transport. Real MCP SDK and raw HTTP are stable protocol seams, fixed session/status/tool-result outcomes are independent oracles, and route implementation changes do not affect them. These own engine `/mcp` hosting; `apps/mcp/test` owns tool semantics.

| Baseline test | Failure and unique oracle |
| --- | --- |
| `serves the jasper-mcp tools to an SDK client with the engine token` | MCP client cannot list/call tools or persist project change; real SDK session plus saved marker in project document. |
| `requires the token and a known session` | Anonymous or uninitialized caller reaches tools; protocol's 401/404/400 statuses for token/session/initialize. |

### `apps/engine/test/uploads.test.ts`

All three are **R** because tautological helper comparisons, internal queue inspection, or test-only injection hooks were removed. S04:IN-005/011 and SC-005 specify the independent upload, disk and expiry contracts. HTTP responses, served bytes, media derivative status, and real service state are stable seams; fixed offsets/statuses/bytes/24 h provide independent oracles. Each scenario is the lowest owner for a distinct upload failure, and survives a storage implementation refactor.

| Baseline → retained test | Failure, oracle and unique owner |
| --- | --- |
| `uploads clip-b in 3 chunks, rejects a wrong offset with the expected one, and registers the media` | Chunk replay/out-of-order write corrupts media; declared byte offsets, 409 expected offset, full stored/served bytes and registered metadata. Removed fingerprint comparison to the same production helper and queue-kind inventory; public media derivative states now prove scheduling. |
| `aborts sessions and validates ids` → `aborts an upload session` | Cancelled upload remains resumable; first DELETE succeeds and repeated DELETE is 404. Removed a traversal URL that only exercised route matching, and changed the filename to an ordinary upload name. |
| `checks free disk space (DISK_FULL) and expires idle sessions after 24 h (S04:SC-005)` | Oversized upload allocates data or stale session remains; actual filesystem free-space probe rejects `Number.MAX_SAFE_INTEGER` with exact `DISK_FULL` before any session file, normal small upload succeeds, and a fake system Date advances 25 h for expiry. This replaces service-only `freeBytes`/`now` injection hooks, which had zero production callers. |

### `apps/engine/test/agent.test.ts`

All K/R tests here derive from S01:AGT-002/020, S01 AC-11, ARCHITECTURE §11, or `docs/wp-notes/wp-mcp.md`. The HTTP/WS response, on-disk document, public `AgentService` timeout result, or published event is the stable seam (bar 4), with literal protocol codes/revisions/ref data independent of implementation (bar 3). The service seam is used only where the public route would require a real timeout or a separate unauthorized socket. All assertions target results rather than private method shape and survive service refactoring (bar 5); each row gives the failure and unique lowest owner (bars 2 and 6).

| Disposition and baseline test | Failure and unique oracle |
| --- | --- |
| K — `describes commands, queries, addressing, approvals and error codes` | Agent cannot discover schemas/error codes; specified schema categories and approval command through GET schema. |
| K — `publishes editor.openProject globally and reports listening editors; 404 for unknown projects` | Connected editor does not open requested project or unknown project appears valid; specified event/status/path. |
| R — `reports the HTTP endpoint and the stdio bundle path, never the token` | Help screen leaks the engine token; token-configured engine request and response serialization must exclude the actual token while matching public MCP-info schema. Former no-token setup could pass for the wrong reason. |
| K — `finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides` | Agent launch cannot locate MCP bundle in installed/checkout layouts; documented paths and explicit override via launcher entry resolution. |
| K — `applies, saves a new revision and publishes doc.changed` | Headless agent appears successful without durable edit; specified revision, saved marker and global change event. |
| D — `applies the S01 Appendix B transaction (text clip, temp ref, opacity fade, marker)` | Asserted only `ok` and a generated ref after replaying the spec example, without checking resulting title/fade/marker. Headless persistence above and project command tests own observable outcomes. No seam removed. |
| K — `rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404` | Headless agent deletes without approval or works on missing project; specified error code/status and session-only query rejection. |
| K — `rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)` | Agent overwrites concurrent edit or rejects safe disjoint change; fixed revision/error and successful fast-forward. |
| K — `relays transactions and queries to the session that holds the lease and forwards its events` | Live editor commands/query/events are lost or applied headlessly; fixed WS request-response envelopes and forwarded event. |
| K — `asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED` | Destructive edit proceeds on deny or approved edit never reaches editor; specified decision/error/protocol flag. |
| K — `falls back to headless when the session disconnects before a request` | Agent request hangs after editor disconnect; successful persisted headless result. |
| K — `returns E_APPROVAL_TIMEOUT when nobody answers the approval` | Destructive request hangs or auto-approves; specified timeout code and cleared pending state at the service timeout seam. |
| K — `ignores approval answers from connections that never said hello` | Unauthenticated socket approves deletion; timeout remains the independent security oracle. |
| K — `returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired` | Ghost lease causes silent headless write or never recovers; specified live error then expired lease success. |
| R — `relays a session response and rejects oversized transactions (limits)` → `rejects oversized transactions (limits)` | Oversized transaction bypasses specified `E_LIMIT`; 5,001 commands and fixed code via `AgentService`. Duplicate relay portion was already owned by the WS relay case. |
| D — `persists the envelope and refuses a stale base revision` | Repeated project save/conflict through a thin adapter. Agent headless persistence and `projects.test.ts` If-Match conflict are stronger public owners. `createCoreAgentStore` remains production wiring, so no production seam removed. |

### `apps/engine/test/projects.test.ts`

All six are **K**. S01:PER-002/016/020/025/040 and WP-2E define independent envelope, revision, version, view and lease contracts. HTTP routes, the public `EngineProjectStore`, and the production filesystem store with controlled clock are stable seams. Literal HTTP status/revision/persisted file and lease outcomes do not derive from implementation; these tests survive internal store changes. Each row owns a distinct caller failure; the client adapter integration covers interoperability that direct HTTP tests cannot prove.

| Baseline test | Failure and unique oracle |
| --- | --- |
| `creates, lists and opens a project envelope` | Created project missing, wrong preset or traversal accepted; expected project envelope/schema and 400/404 outcomes. |
| `saves with If-Match revisions and answers 409 with the current revision on conflict` | Concurrent writer silently overwrites state; expected 409/current revision and persisted winner. |
| `works end to end with the session EngineProjectStore (open → save → conflict)` | Session adapter cannot speak engine protocol; open/save/conflict/view/version/lease/delete via real client/store pair. |
| `keeps versions at most every 5 minutes of saving (S01:PER-020) and stores the view file` | Undo safety copies missing or excessive; fixed clock with version revisions at 0/2 and durable view. |
| `grants one holder, refreshes by heartbeat, expires after 30 s and releases` | Two editors write concurrently or expired holder blocks work; specified 409/heartbeat/30 s/release. |
| `takeOver revokes the other holder (WP-2E "Take over editing")` | User takeover leaves old editor writable; new lease and old heartbeat 404. |

### `apps/engine/test/media.test.ts`

All cases are **K** except the marked rewrite. S01:AST-001 and S04:PB/TH/WF/PX/MS define expected fixture properties, codecs, duration, rendered pixels, HTTP bytes and security responses. Real FFmpeg fixtures, public registration/media HTTP routes, ffprobe/decoder, and served artifacts are stable seams. The fixtures, protocol bytes and spec numbers are independent oracles; assertions survive internal code reshaping. This is the lowest owner for real media/proxy output and HTTP byte serving. Unit probe tests cover only synthetic legacy/VFR metadata.

| Disposition and baseline test | Failure and unique oracle |
| --- | --- |
| R — `clip-a: 10 s 1080p30 H.264 + stereo AAC, browser playable` | Misclassified real source; fixture-known duration/codec/streams in registration response. Removed self-comparison to `fingerprintFile`, the same routine used by registration. |
| K — `phone-rot90: display-matrix rotation 90, 5 s, stored landscape` | Video displayed sideways; fixture-known rotation and upright display dimensions. |
| K — `still.png is an image without duration; tone.wav is audio` | Still gets bogus duration or audio is classified video; known fixture kinds/streams. |
| K — `re-registering the same file returns the same key (dedupe by fingerprint) and bad paths error per file` | Duplicate media record or one bad path aborts batch; stable key and per-file error codes. |
| R — `poster, sprite + index and peaks are produced, content-addressed and parseable` → `poster, sprite + index and peaks are produced and parseable` | Missing/unreadable filmstrip or waveform; S04:TH-002/WF-001 numeric header, JPEG signature, PCM peak magnitude, served via URLs. Removed private cache-directory filename regex and second identical poster request whose success did not prove dedupe. |
| K — `forces a 720p proxy for a non-browser-playable source` | Legacy source cannot preview; ffprobe verifies produced H.264 960×720 and fast-start metadata from S04:PX-001. |
| K — `makes a VP9 WebM proxy that keeps the alpha channel of a ProRes 4444 overlay` | Transparent overlay becomes opaque; real decoded alpha pixels and VP9/WebM media response, unique alpha pipeline. |
| K — `supports HEAD, single Range → 206, suffix ranges, 416, ETag/304 and If-Range` | Browser seeks/caches wrong bytes; S04:MS-002 statuses/headers and source-file byte slices. |
| K — `rejects unknown or malformed keys, and reports derivatives that are not ready as 404` | Unknown asset or unavailable derivative served; documented 404 responses. |
| K — `serves signed URLs to cookie-less consumers in token mode (S04:MS-003) with CORS for the headless browser` | Unauthenticated fetch, mutable signed request or broken headless render access; fixed 401/206/204 and CORS headers through HTTP. |

## Engine rendering tests

Scope: apps/engine/test/anime-scaffold.test.ts, anime-templates.test.ts, anime.test.ts, page-pool.test.ts, lgpl-binaries.test.ts, lgpl.test.ts, mg-bundles.test.ts, mg.test.ts, native-ext.test.ts, tracking-bundle.test.ts, remotion.e2e.test.ts, remotion-lgpl.e2e.test.ts, shapes-remotion.e2e.test.ts; layer-bake files are in the companion fragment.

Six-bar key for every KEEP/REWRITE row: the listed source is an independent product/protocol/security requirement (1); the listed regression is observable by an editor user, API caller, renderer, or license recipient (2); the oracle is a literal independent requirement, fixture input/output, media probe, pixel reference, or HTTP code rather than a production constant or mock return (3); the seam is the route, rendered artifact, generated project, or required resource scheduler/service behavior (4); the assertion does not rely on private collaborator names or command shape and survives an equivalent implementation (5); the listed owner is the lowest stable seam for the distinct contract, with duplicate probes deleted (6). A K code below supplies these six facts; rows identify their K code.

K-A scaffold: S08:MGC-015/S11:ANM-016; generated project must compile and timeline must return identical values in any seek order; oracle is esbuild success plus a fresh-build frame sequence and documented endpoint values; generated project is the stable seam; no other suite covers bundled anime example execution.
K-B anime route: S11:ATP-008/010; catalogue renderer/native classification, refusal of anime-only route, and missing-template code across exports/stills; oracle literal renderer/code and external job state; HTTP API is stable; no other suite covers these route choices. The range exception is checked at planner boundary because an unrenderable missing template outside a still range should not block a render, and no other test covers it.
K-C license/version: D-13/S11:ANM-011 and license obligations; wrong package pin, missing/falsified About text, or GPL labeling fails; oracle literal 4.5.0, MIT/LGPL/SPDX requirements and committed-vs-upstream license bytes; /api/licenses or source package artifact is stable; remaining suites do not prove packaged fallback text.
K-D bundle invalidation: S11:FIX-009/MGC-031; a changed lockfile, source, props, span, or bundle must invalidate cached output while key order and unchanged inputs reuse it; oracle compares identities before/after independently chosen mutations; service sourceHash/renderKey is the production cache seam; actual export E2E owns rendered cache hits, unit cases own unique inputs not covered there.
K-E resource scheduler: S11:LBK-022; over-budget pages, excess active renders, inaccurate progress, uncancelled children, or leaked work on failure is visible as failed/hung exports or misleading Jobs progress; oracle is manually settled tasks and invariant bounds/codes (not their mocked outputs); runPagePool is the lowest stable scheduler seam; layer-bake E2E owns rendered concurrency, these tests own isolated failure/abort/budget cases.
K-F binary/config: Architecture D-13; bad selection, GPL build in strict mode, wrong capability/encoder, missing license text, or failed export/proxy violates packaged/config behavior; oracle literal allowed flags, LGPL/buildconf, HTTP capability, ffprobe output and license files; resolver/HTTP/rendered files are the stable seams; E2E owns actual codecs, focused resolver tests own error/precedence cases unavailable in E2E.
K-G bundle import/security: S08:MGC-001/010/011/015/021/031 and ZIP path rules; unsafe path acceptance, missing schema/hints, wrong pin, unreadable upload, stale cache, or wrong HTTP Range fails; oracle known fixtures, literal error/status/schema fields, input mutations and output files; zip reader/scaffold/routes are stable consumer boundaries; real MG E2E owns actual browser/master rendering.
K-H MG rendering/jobs: S04:MG-010/012/013 and WP-3I; failed/unusable master, wrong frame count/alpha, broken Range, job cancel/retry, invalid spec, or leftover output fails; oracle ffprobe/pixels/HTTP states and files; public routes/real media and MG service cache are stable seams; no stronger test covers jasper-mg's actual pipeline and cancellation.
K-I Remotion E2E: S04:RR-001…006/D-13; missing text render/still, wrong strict-mode capabilities, GPL binary, wrong H264/VP9/Opus output, or broken compositor still fails; oracle HTTP/ffprobe/buildconf/output PNG; full engine and encoded files are stable; LGPL suite owns strict mode, generic suite owns blend-mode Remotion path.
K-J shape visual regression: S11:SHP-004 explicitly requires analytic rendered shape geometry; wrong fill/stroke/alpha or placement fails on a real still; oracle is independent supersampled geometric reference and pixel probes; PNG output is stable; no other suite covers rendered inside/outside/center stroke semantics.

### Test dispositions

#### `apps/engine/test/anime-scaffold.test.ts`
- DELETE `is scaffolded: AnimeTitle registered, schema + manifest entry, animejs pinned, README rule`: source/manifest grep and prose copy; compile/runtime plus mg-bundles scaffold/import own behavior.
- DELETE `follows the contract: lint-clean as runtime code, autoplay off, the canonical seek, no wall clock`: source regex/checker; order-independence runtime test is stronger.
- KEEP `the scaffolded project compiles (esbuild bundle of src/index.ts with the workspace packages)` — K-A; compilation catches broken generated imports.
- KEEP `the example timeline is order-independent (bundled with the pinned anime.js)` — K-A; runtime frames catch nondeterministic seek.

#### `apps/engine/test/anime-templates.test.ts`
- REWRITE `lists anime templates with renderer anime and native false` — K-B; retain only known title-reveal API classification; remove inventory/order/copy checks.
- KEEP `the render route refuses anime templates whatever the fframes state (400 ANIME_TEMPLATE)` — K-B; wrong route would execute unsupported renderer.
- DELETE `requestRender and the master provider never send anime templates to jasper-mg`: private service duplicate of HTTP route, mocked missing binary.
- DELETE `without a claiming extension: a native blocker, auto plans remotion, forced native is refused`: planner collaborator shape; layer-bake E2E/render path owns real routing.
- DELETE `a claiming extension (layer-bake) removes the anime blocker`: mock implements claim; real layer-bake E2E owns behavior.
- DELETE `re-stamps a renderer that contradicts the registry before planning`: snapshot internal state; API catalogue/render route owns renderer classification.
- DELETE `planExport throws TEMPLATE_NOT_INSTALLED for auto, native, remotion and stills`: duplicate of API exports/still below.
- REWRITE `only clips inside the exported range count` — K-B; retain no missing-template blocker for an out-of-range still, removing no-op path assertion.
- REWRITE `POST /api/exports and /api/exports/plan answer 409; a still job fails with the same code` — K-B; literal error code replaces expected value imported from owner.
- DELETE `installed templates of both renderers plan normally`: assertion-free path/constant check; route and real export own success.

#### `apps/engine/test/anime.test.ts`
- REWRITE `the pinned version matches packages/motion and the installed package` — K-C; literal pin and upstream license bytes replace owner constant/function.
- KEEP `lists anime.js (MIT, with its text) in /api/licenses and fills features.anime` — K-C; API license/capability result.
- REWRITE `packaged-like: without the installed package, the committed licence text and the pinned version` — K-C; literal pin.
- DELETE `is registered after mg-bundles and before tracking; anime is appended`: route-array inventory, private ordering.
- DELETE `POST /api/layer-bake/preview is implemented (validates its body)`: duplicate of layer-bake route validation.
- DELETE `LayerOverride carries still / rect / colorRuns (types only)`: type declaration asserted against itself.
- REWRITE `changes with the lockfile and with the sources of every bundled workspace package` — K-D; independent named packages, production RemotionService.sourceHash seam, no test-only exported hash helper.
- DELETE `hashes the real workspace (motion included)`: only shape/length of a hash, no input mutation.

#### `apps/engine/test/page-pool.test.ts`
- DELETE `masters split the budget by length: at least 1 page, at most the budget and one page per 10 frames`: copies heuristic and constant, no caller-visible outcome.
- REWRITE `starts the largest first and backfills small renders; pages in flight never exceed the budget` as `never grants more pages than the render budget` — K-E; budget invariant only, not scheduling order.
- DELETE `waits rather than starting a large render with less than half its pages, unless nothing else runs`: private performance heuristic.
- KEEP `bounds the renders in flight; maxInFlight 1 runs them one after the other with the whole budget` — K-E; active render bound.
- KEEP `aggregates progress by weight and counts finished renders` — K-E; Jobs progress contract.
- KEEP `the first failure aborts the renders in flight, starts no more, and rejects once all have settled` — K-E; failed child cleanup.
- KEEP `aborting the signal cancels every render in flight and rejects with JOB_CANCELLED` — K-E; cancellation cleanup.

#### `apps/engine/test/lgpl-binaries.test.ts`
- KEEP `prefers env → packaged resources → vendor` — K-F; override/packaged precedence.
- REWRITE `dev without a directory: Remotion bundled FFmpeg with the loud GPL warning` — K-F; literal visible warning instead of owner constant.
- REWRITE `packaged (strict) without a directory refuses the Remotion path` — K-F; refusal/LGPL message instead of owner constant.
- REWRITE `a configured but incomplete directory never silently falls back` — K-F; visible warning/refusal, not owner constant.
- KEEP `uses .exe names on Windows` — K-F; cross-platform executable lookup.
- KEEP `walks up to vendor/ffmpeg-lgpl/<platform> with a BUILDINFO.json` — K-F; packaged binary discovery.
- KEEP `env → <resources>/bin → <resources>/ffmpeg-lgpl → vendor → PATH` — K-F; native resolver precedence.
- KEEP `strict without the LGPL directory: remotionLocal unavailable and renders refuse to start` — K-F; actual service refusal code.
- KEEP conditional `a directory with a GPL FFmpeg is refused in strict mode (license probe)` — K-F; shipped compositor cannot silently use GPL.
- KEEP `a bundled LGPL 3 build: SPDX id, exact source, build link, LGPL text and the GPL 3 text it refers to` — K-C/K-F; legal attribution.
- KEEP `a bundled LGPL 2.1 source build has one license text and no prebuilt link` — K-C/K-F; legal attribution.
- KEEP `a system ffmpeg, or a directory whose ffmpeg is not LGPL, is never presented as our bundled build` — K-C/K-F; provenance safety.
- KEEP conditional `the vendored directory (pnpm ffmpeg:lgpl) yields a complete entry` — K-C/K-F; real shipped artifact check.
- REWRITE `H.264 with the LGPL directory: ProRes intermediate, then our encoder (two phases)` — K-F; retains codec/mode, drops progress weight/label shape.
- DELETE `hardware H.264 gives the render phase a larger share; AV1 a smaller one`: private progress weight heuristic.
- KEEP `dev with GPL builds on both sides and libx264: Remotion encodes H.264 itself (unchanged)` — K-F; dev-only policy.
- KEEP `libx264 selected but Remotion uses the LGPL directory (no x264 there): intermediate` — K-F; avoids unavailable GPL encoder.
- REWRITE `VP9 WebM + Opus goes direct through Remotion with mapped CRF and speed args` — K-F; retain direct VP9/Opus and color capability; drop expected CRF derived from production and private ffmpeg arg array.
- KEEP `VP9 in MP4 (no Opus) or a Remotion build without libvpx-vp9: intermediate` — K-F; compatibility fallback.
- KEEP `no usable encoder: unavailable with LGPL (or LGPL-only), Remotion GPL H.264 only in plain dev` — K-F; policy error.
- DELETE `adds encoder options before the output file of the command that encodes with that encoder`: private Remotion callback command shape; VP9 output E2E owns actual effect.

#### `apps/engine/test/lgpl.test.ts`
- REWRITE `reports the encoder inventory without GPL encoders in /api/capabilities` — K-F; literal deny list rather than production GPL_ENCODERS constant.
- KEEP `plans and runs a real native export with an LGPL-compatible encoder` — K-F; ffprobe encoded artifact.
- KEEP `makes proxies with an LGPL-compatible encoder (MP4)` — K-F; ffprobe proxy artifact.

#### `apps/engine/test/mg-bundles.test.ts`
- KEEP `extracts stored and deflated entries and refuses unsafe paths` — K-G; ZIP extraction/path traversal boundary.
- REWRITE `hashes paths and bytes deterministically` — K-D/K-G; retains content mutation identity, drops hash format/media-key derivation.
- KEEP `refuses projects that do not pin remotion 4.0.499 (MG_REMOTION_VERSION with a hint)` — K-G; exact dependency policy and distinct error codes.
- REWRITE `writes the template pinned to 4.0.499 with a schema module and manifest; refuses non-empty dirs` — K-G; retains literal generated dependency pin and 409 overwrite refusal, drops source inventory.
- KEEP `converts the fixture schema module (zod 4) in a child process` — K-G; external user schema fixture.
- KEEP `converts zod 3 schemas with zod-to-json-schema and reports broken modules as warnings` — K-G; backward schema compatibility/error surfacing. Timeout raised to 15 seconds after initial 5-second infrastructure timeout under concurrent test load.
- KEEP `takes the manifest first, then the schema module, then inference; merges UI hints` — K-G; externally supplied precedence and UI schema.
- DELETE `injects the protocol bootstrap before the bundle scripts`: host HTML/script shape; route and browser E2E own host operation.
- KEEP `changes with props, bundle, size, fps and range — never with key order` — K-D; cache key consistency and invalidation.
- DELETE `makes composition clips native-capable, with blockers when the renderer or the bundle is missing`: fake service implements capability, planner collaborator shape; native export E2E owns.
- DELETE `requests masters for the drawn span (handles included) and overrides the layer source`: private extension override and FFmpeg graph; frame-exact real export E2E owns.
- DELETE `renders distinct keys within the page budget, reuses cached ones, cancels the rest on abort`: mocked prerender writes fake master and duplicates page-pool scheduler/real cache E2E.
- KEEP `serves bundle files (Range, traversal-safe) and the live host page; caches and GC` — K-G; HTTP file/security/cache policy.
- KEEP `reports features.mgBundles; validates imports; refuses unknown bundles and non-rebuildable ones` — K-G; API capability/validation status.
- KEEP `bundle uploads are completed by the import, not by the media registry` — K-G; upload protocol ownership.
- KEEP `test 2: imports the project — Title schema from the module, Badge inferred, manifest hints` — K-G; real imported project response.
- DELETE `test 2: a project pinned to another Remotion version fails with MG_REMOTION_VERSION`: duplicate version-pin unit owner above; browser work adds no distinct failure.
- KEEP `test 2: a zip of the built bundle imports on the web (upload) path` — K-G; real upload/import artifact.
- KEEP `tests 5 + 6: native export with a cached master, frame-exact, straight alpha; cache hits and invalidation` — K-G/K-D; ffprobe/pixel/media output and cache jobs.
- KEEP `rebuilds a watched project after a source edit: new bundle hash, new master (MGC-013)` — K-D/K-G; watcher event/new identity.
- DELETE `the clip document keeps working with the relinked bundle (composition model)`: asserts locally constructed clip and fixture path, no relink action.

#### `apps/engine/test/mg.test.ts`
- DELETE `an explicit JASPER_MG that does not exist is unavailable with a reason (no fallback)`: duplicated by public route 503 test.
- DELETE `reports unavailable outside a checkout without a binary`: synthetic empty directory, no distinct caller-visible behavior.
- REWRITE `degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE` — K-H; API capability/status/error, drops exact inventory/order/defaults and private provider.
- KEEP `validates requests and file names` — K-H; HTTP validation and path rejection.
- DELETE `builds the documented ffmpeg pipe arguments`: internal command shape, real ProRes render owns output.
- KEEP `renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master` — K-H; real media/pixel/Range/cache artifact.
- KEEP `mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)` — K-H; HTTP job lifecycle.
- REWRITE `rejects invalid params with 400 and cancels running renders without leftovers` — K-H; retains invalid route and real cancel/output cleanup, drops private hook and duplicate shutdown paths.
- REWRITE `uses the TS registry to validate and keys renders deterministically` — K-D/K-H; retains key-order invariance and duration invalidation, drops registry inventory/hex shape.

#### `apps/engine/test/native-ext.test.ts`
- DELETE `an effect nobody realizes blocks; an extension that supports it unblocks it`: fake extension supplies both policy and filter; real color/warp/layer-bake tests own effects.
- DELETE `a claimed layer skips the generic checks and is overlaid from its sequence-space override`: fake override; layer-bake real export owns.
- DELETE `extension kinds become native-capable (e.g. composition clips)`: fake set declaration; MG real export owns.
- DELETE `sampleRuns groups equal per-frame values`: implementation unit with no distinct visible bug; rendered color grade owners remain. Entire file removed.

#### `apps/engine/test/tracking-bundle.test.ts` (removed by warptracking agent)
- DELETE `runs a planar track job from the bundle`: synthetic esbuild stdin entry, not production bundle; HTTP tracking.test.ts fixture owns accuracy.
- DELETE `runs the warp pool workers from the bundle`: synthetic private export bundle; warp-unit/native export own real warp. Entire file removed.

#### `apps/engine/test/remotion.e2e.test.ts`
- KEEP `renders 30 frames of a text-only sequence and a still` — K-I; real blend-mode Remotion media/still path.
- DELETE `renders a ProRes intermediate and encodes it with the selected LGPL-compatible encoder`: duplicate strict LGPL H264 E2E below.

#### `apps/engine/test/remotion-lgpl.e2e.test.ts`
- KEEP `reports the LGPL directory in /api/capabilities (strict mode accepts it)` — K-I/K-F; packaged capability.
- KEEP `its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264)` — K-F; real binary legal policy.
- KEEP `exports H.264 via a Remotion ProRes intermediate encoded with OpenH264` — K-I/K-F; real H264/AAC artifact.
- KEEP `exports VP9/Opus WebM directly through Remotion` — K-I/K-F; real VP9/Opus artifact.
- KEEP `renders a still through the LGPL compositor` — K-I/K-F; strict-mode PNG artifact.

#### `apps/engine/test/shapes-remotion.e2e.test.ts`
- KEEP `edges, stroke widths and colours of rect / circle / ellipse with inside, outside and centre strokes` — K-J; explicit visual regression requirement and independent analytic pixel reference.

### Production seams/support removed
- apps/engine/src/mg/render.ts: ffmpegArgs export removed (production still calls private helper).
- apps/engine/src/remotion/page-pool.ts: MIN_FRAMES_PER_PAGE and poolOrder exports removed; production internal uses remain.
- apps/engine/src/remotion/export-plan.ts: renderWeight export removed; production internal use remains.
- apps/engine/src/remotion/service.ts: BUNDLED_WORKSPACE_PACKAGES and remotionSourceHash exports removed; class still uses them.
- apps/engine/src/anime/index.ts: ANIMEJS_PINNED_VERSION and animejsPackageDir exports removed; internal uses remain.
- apps/engine/src/color/extension.ts: unused `gplFiltersIn` export and GPL filter scan removed after layer-bake graph assertions were deleted.
- Native-ext synthetic test fixtures, MG fake prerender runner, and page-pool heuristic probes removed. Production behavior unchanged. MG bundle E2E setup no longer calls the private `MgBundleService.remotionOptions` helper; its native-export/master comparison passed after the change.

Risk and validation: Chrome/FFmpeg gated E2E tests require REMOTION_E2E=1/MG_E2E=1 and local binaries; ordinary engine suite does not execute those gates. Focused command: `cd apps/engine && pnpm exec vitest run test/anime.test.ts test/anime-scaffold.test.ts test/anime-templates.test.ts test/page-pool.test.ts test/lgpl-binaries.test.ts test/mg.test.ts test/mg-bundles.test.ts --maxWorkers=2`. Engine typecheck: `pnpm --filter @jasper/engine typecheck`. Root handles full lint/test gates. Final rendering validation: default scoped suite 54 passed, 11 opt-in skipped; `REMOTION_E2E=1` 3 files/7 passed; `MG_E2E=1` bundle suite 1 file/15 passed. Engine typecheck, targeted Biome, and `git diff --check` passed. Artifacts include `/var/lib/orquester/tmp/jasper-shapes-rcbA4Q/still.png` and `/var/lib/orquester/tmp/jasper-engine-KR99d6/renders/job_c6de0ab912569115/output.mov` (ProRes, 1920×1080, 60 frames).

## Layer bake tests

Independent source: `docs/specs/11-animation.md` §6 (LBK-001…031), §11 test 4, plus `docs/wp-notes/wp-m2-layer-bake.md` review fixes. Owners read: `apps/engine/src/layer-bake/{layer,key,service,extension}.ts`, `apps/engine/src/export/{planner,native,service}.ts`, `apps/engine/src/remotion/service.ts`, layer-bake routes. Validation: `pnpm exec vitest run apps/engine/test/layer-bake.test.ts apps/engine/test/layer-bake.e2e.test.ts apps/engine/test/layer-bake-parallel.e2e.test.ts`; `pnpm --filter @jasper/engine typecheck`; optional `REMOTION_E2E=1` for real-browser cases. Risk: E2E cases are opt-in and may need browser/ffmpeg. Verified artifacts persist under `/var/lib/orquester/tmp`: `jasper-lb-e2e-kZDOJp/renders/`, two parallel comparison MOVs under `jasper-lbp-e2e-rUb79k/renders/`, and `layer-bake-parallel.txt`. Final main browser E2E passed 7/7 after folding the usage check into the hybrid artifact case, and parallel browser E2E passed 2/2; engine typecheck, targeted Biome and diff checks passed.

### Exact baseline title index

The short names in the reasoning tables below refer to these exact pre-edit cases.

| Path | Baseline test title | Disposition |
| --- | --- | --- |
| `apps/engine/test/layer-bake.test.ts` | claims every text clip, shapes and anime templates; not fframes templates or media | KEEP |
| `apps/engine/test/layer-bake.test.ts` | static = no animator, no keyframes anywhere, no anime template, no unknown effect | REWRITE |
| `apps/engine/test/layer-bake.test.ts` | a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010) | KEEP |
| `apps/engine/test/layer-bake.test.ts` | normalises the baked clip: span-relative times and fades, one-frame stills, whole-pixel shifts | DELETE |
| `apps/engine/test/layer-bake.test.ts` | is the union of the per-frame layer bounds plus a 10 % bleed, even-aligned and clamped | DELETE |
| `apps/engine/test/layer-bake.test.ts` | covers the whole frame when the layer is large; a minimal rect when it is off-screen | DELETE |
| `apps/engine/test/layer-bake.test.ts` | changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration | KEEP |
| `apps/engine/test/layer-bake.test.ts` | font files enter the key by content hash | DELETE |
| `apps/engine/test/layer-bake.test.ts` | identical titles share a bake unless they are seeded by their clip id (text animators, anime templates) | KEEP |
| `apps/engine/test/layer-bake.test.ts` | fonts of styled runs belong to the bake (any font id the clip source mentions) | DELETE |
| `apps/engine/test/layer-bake.test.ts` | only the faces a text draws with: other weights of its font do not enter the bake (review fix 5) | REWRITE |
| `apps/engine/test/layer-bake.test.ts` | graded stills get the transition fades; grade keys hold the real timing (review fixes 1 and 3) | DELETE |
| `apps/engine/test/layer-bake.test.ts` | masters key the span; the clip id only enters the key of seed-bearing layers | DELETE |
| `apps/engine/test/layer-bake.test.ts` | footage + titles + shape + anime template plan `hybrid` with one graphics group per baked layer | KEEP |
| `apps/engine/test/layer-bake.test.ts` | without Remotion every DOM layer is blocked; blend modes still block; no extension = "requires graphics rendering" | REWRITE |
| `apps/engine/test/layer-bake.test.ts` | `needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD) | KEEP |
| `apps/engine/test/layer-bake.test.ts` | warns when a colour effect precedes a pixel-mixing effect on a DOM layer | KEEP |
| `apps/engine/test/layer-bake.test.ts` | loops a still with the fades applied, overlays a rect, grades with lut3d, uses no GPL filter | DELETE |
| `apps/engine/test/layer-bake.test.ts` | GC removes entries unused for 14 days and keeps the others | KEEP |
| `apps/engine/test/layer-bake.test.ts` | GC keeps entries held by running jobs and entries a lookup marks used meanwhile (review fix 4) | REWRITE |
| `apps/engine/test/layer-bake.test.ts` | graded masters are PNG frame sequences served per frame under one signed URL (review fix 1) | KEEP |
| `apps/engine/test/layer-bake.test.ts` | features.layerBake reports readiness and the cache size | REWRITE |
| `apps/engine/test/layer-bake.test.ts` | POST /api/layer-bake/preview validates the request and the clip | KEEP |
| `apps/engine/test/layer-bake.test.ts` | the usage log records every Remotion call with its purpose (LC-004, LBK-026) | KEEP |
| `apps/engine/test/layer-bake.test.ts` | runs the bakes side by side within the budget, in one shared browser, and reports "Baking graphics i/n" | DELETE |
| `apps/engine/test/layer-bake.test.ts` | maxInFlight 1 is the sequential path: one bake at a time, masters with the whole budget, own browsers | DELETE |
| `apps/engine/test/layer-bake.test.ts` | a failing bake cancels the others and fails the preparation with its error | DELETE |
| `apps/engine/test/layer-bake.test.ts` | aborting the export cancels every bake in flight and starts no more | DELETE |
| `apps/engine/test/layer-bake.test.ts` | two parents needing the same bake render it once; when its owner is cancelled the other renders it | DELETE |
| `apps/engine/test/layer-bake.test.ts` | a prebuilt bundle is identified by its stamp, else by its content; dev bundles by the source hash | DELETE |
| `apps/engine/test/layer-bake.test.ts` | auto → Remotion with NATIVE_FALLBACK; forced native fails with the cause | DELETE |
| `apps/engine/test/layer-bake.e2e.test.ts` | plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %) | REWRITE |
| `apps/engine/test/layer-bake.e2e.test.ts` | masters keep straight alpha: over R/G/B/W within 2/255 of the browser still | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | re-exports hit the cache; moving a title in time hits it too; a text change bakes again | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025) | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002) | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1) | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023) | KEEP |
| `apps/engine/test/layer-bake.e2e.test.ts` | the composites use no GPL filter (LBK-031) and every bake is in the Remotion usage log (LBK-026) | REWRITE |
| `apps/engine/test/layer-bake-parallel.e2e.test.ts` | bakes side by side in one browser; masters, stills and the composite equal the sequential path | REWRITE |
| `apps/engine/test/layer-bake-parallel.e2e.test.ts` | a second export needing the same bakes while they render joins them: each is rendered once | DELETE |
| `apps/engine/test/layer-bake-parallel.e2e.test.ts` | cancelling the export cancels every bake in flight and closes the shared browser | REWRITE |
| `apps/engine/test/layer-bake-parallel.e2e.test.ts` | benchmark: cold-cache exports, modes alternating (LAYER_BAKE_BENCH=1) | DELETE |

### Baseline disposition (initial)

`apps/engine/test/layer-bake.test.ts`:

| Baseline test (short name) | Disposition | Detectable failure / stronger owner / seam callers |
| --- | --- | --- |
| claims every text... | KEEP | Wrong clip ownership; planner/extension call `isDomLayer`, public plan and E2E also exercise examples. |
| static = no animator... | REWRITE | Wrong still/master choice for keyframes, shape, anime, unknown effect; service calls `isStaticLayer`; E2E covers ordinary static/animated but not unknown effect. |
| a keyframed grade... | KEEP | Graded static layer wrongly needs an animated master or drops colour; service and extension call `bakeClip`; grade E2E covers visible colour. |
| normalises the baked clip... | DELETE | Internal snapshot field map; cache reuse and still E2E own visible effects. |
| crop rect union... | DELETE | Geometry implementation; full rendered parity E2E catches visible clipping. |
| crop covers whole/offscreen... | DELETE | Private rect fallback and exact 2px shape; parity E2E is stronger. |
| key changes with text/font/environment... | KEEP | Stale cache when inputs or renderer identity change; `planBake` service used by export/preview. |
| font files enter key by hash | DELETE | Key fixture is manually altered then compared to key function; face/key test and cache E2E cover behavior. |
| identical titles share unless seeded | KEEP | Random animation would reuse wrong pixels; service key and E2E cache exercise key use. |
| fonts of styled runs | DELETE | Duplicated by face-selection regression just below. |
| only faces a text draws with | REWRITE | Unused font face must not invalidate a title; service key owner; no stronger E2E for this review fix. |
| graded stills get fades... | DELETE | Asserts private filter text/key structure; graded fade E2E catches real output failure. |
| masters key span... | DELETE | Private material fields; cache reuse E2E and retained seed test own observable behavior. |
| planner hybrid... | KEEP | Wrong public export plan with DOM layers; E2E output parity provides stronger render check, API plan is lowest seam for planning. |
| without Remotion... | REWRITE | Forced native should reject unavailable renderer; route/plan API is stable. |
| needs-browser-download... | KEEP | Warning code is API contract; planner capability injection needed to simulate host state. |
| effect order warning... | KEEP | User-facing warning of changed effect ordering; pure helper is lowest seam, planner calls it. |
| builder still/rect/color | DELETE | Private FFmpeg graph shape; rendered parity, grade and fade E2E are stronger. |
| GC removes stale entries | KEEP | Persistent cache TTL and public file route; service GC lowest practical seam. |
| GC keeps held entries | REWRITE | Exported cache entry must survive GC during active job; service/queue seam, no stronger concurrent GC coverage. |
| graded PNG route | KEEP | HTTP frame selection and path validation are protocol behavior. |
| capability ready/cache size | REWRITE | Capabilities API shape; remove monkey-patched private `unavailableReason` assertion. |
| preview validates request | KEEP | HTTP errors and codes caller-visible, no stronger validation owner. |
| usage log direct call | DELETE | Calls logger directly with asserted purpose; real E2E bake log owns behavior. |
| parallel runs within budget | DELETE | Large mocked collaborator-shape test; real parallel E2E owns overlap and pixel equality. |
| sequential maxInFlight | DELETE | Private tuning path; real parallel E2E compares sequential and parallel. |
| failing bake cancels others | DELETE | Mock behavior, and export fallback/cancel E2E protect user workflows. |
| aborting export cancels all | DELETE | Real parallel E2E cancellation is stronger. |
| two parents dedupe/cancel | DELETE | Real parallel E2E checks concurrent reuse; cancellation ownership branch remains a lower-risk unprotected corner. |
| bundle stamp identity | DELETE | Private `bundleId()` format and hard-coded version; build stamp and cache tests are owners. |
| auto fallback with stub render | DELETE | Real Remotion fallback E2E owns job result and artifact. |

`apps/engine/test/layer-bake.e2e.test.ts`:

| Baseline test | Disposition | Detectable failure / stronger owner |
| --- | --- | --- |
| hybrid parity | REWRITE | Wrong rendered DOM compositing; actual output and independent Remotion reference, §11 test 4. |
| straight alpha | KEEP | Opaque/incorrect anti-aliased edges; independently rendered browser still. |
| cache reuse | KEEP | Moving in time must reuse and text edit invalidate; actual export jobs/cache, no stronger owner. |
| still path | KEEP | Stills fail to reuse/bake per frame; exported still artifact and export comparison. |
| grade native/Remotion/preview | KEEP | Grade missing on any path; sampled pixels and preview route. |
| graded static fade | KEEP | Double/missing fade or opaque background; sampled pixels against specified ramp. |
| failing bake fallback | KEEP | Auto fails or forced native silently falls back; public jobs and rendered artifact. |
| GPL filters + usage | REWRITE | Remove dead GPL scan; retain actual render usage log per LBK-026. |

`apps/engine/test/layer-bake-parallel.e2e.test.ts`:

| Baseline test | Disposition | Detectable failure / stronger owner |
| --- | --- | --- |
| parallel vs sequential parity | REWRITE | Parallel scheduling corrupts frames/composite; actual two exports and decoded pixels; drop cache metadata/byte shape. |
| concurrent second export joins | DELETE | Calls extension `prepare` privately as second "export"; cache test and parallel parity cover reuse/behavior; no actual second public export artifact. |
| cancelling export | REWRITE | Child jobs outlive cancel; public export/job states; remove private sessions map assertion. |
| benchmark | DELETE | Measurement harness, no independent expected outcome. |

### Six-bar rationale for proposed survivors

Every KEEP/REWRITE above is anchored to the named S11 LBK requirement or its documented review fix (bar 1). Each has a concrete failure shown in its table (bar 2). The oracle is spec-defined status/code, cache hit/miss, TTL, sampled pixels, or separate render result, rather than copied production constants (bar 3). Pure layer classification, HTTP/job APIs, exported service cache operations and actual output files are the lowest usable stable seams for their contracts (bars 4 and 6); tests of graph/filter/private fields will be deleted. These outcomes tolerate a behavior-preserving implementation refactor (bar 5), although existing E2E setup uses a private `remotionProps` helper and will be assessed during editing.

### Final survivor bar, by baseline test

Columns: C = independent contract; F = recognizable failure; O = independent oracle; S = stable seam; R = survives behavior-preserving refactor; L = lowest owner and non-duplication. All source references below mean S11 §6 unless otherwise stated.

| Test file and baseline test | C | F | O | S | R | L |
| --- | --- | --- | --- | --- | --- | --- |
| unit: claims every text... | LBK-001 clip ownership | A text/shape/anime layer is not baked or an fframes layer is seized | Expected kind ownership is stated in LBK-001 | `isDomLayer` is an exported pure classifier called by service/extension | Checks classification, not call count or source text | Lowest classifier case; public plan E2E checks composite but does not isolate fframes distinction |
| unit: static = no animator... (REWRITE) | LBK-004 and review fix for deep keyframes | Animated shape/text is frozen to one PNG; unknown effect is frozen | Input examples specified by LBK-004; expect static vs animated | Exported `isStaticLayer` used by planning | Ignores implementation traversal and fields apart from user clip inputs | Lowest choice seam; E2E covers ordinary title static/animated, not shape-keyframe or unknown-effect policy |
| unit: keyframed grade... | LBK-004/010 | Grade animation forces a master or gets baked twice | A grade is applied by ffmpeg after static bake per spec | `bakeClip` + `isStaticLayer`, production planning helpers | No private call count or generated filter assertion | Lowest seam for recipe selection; graded E2E checks pixels, not PNG-vs-master performance contract |
| unit: key changes with text... | LBK-020 cache key inputs and exclusions | Edited title/renderer uses stale pixels, or moving a title causes needless render | Equality/inequality from changed user content and environment parameters | `LayerBakeService.planBake`, the export/preview service seam | Hash algorithm and field ordering may change | Lowest deterministic cache-key owner; E2E validates actual hits but cannot cheaply enumerate renderer environment inputs |
| unit: identical titles share unless seeded | LBK-020 and ANM-007 seed semantics | Randomized title shares another clip’s pixels | Same text vs different clip ID/animator settings prescribed in spec | Service `planBake` | Does not require a particular hash or private representation | Lowest seam for seed collision; E2E cache reuse does not create seeded twins |
| unit: only faces a text draws with (REWRITE) | LBK-020 review fix 5 | Adding another title weight invalidates unrelated title’s cache | Unchanged first title must keep key after second weight is introduced | Service `planBake` from real project snapshot | Does not assert selected internal font list | Lowest cache invalidation seam; E2E cache case edits title text only |
| unit: planner hybrid | LBK-002 plan API | DOM layers block native or wrong plan path | Public plan path and layer IDs from fixture | `POST /api/exports/plan` and RenderPlanSchema | No private planner collaborator shape | Lowest API seam for plan result; E2E owns output parity |
| unit: without Remotion (REWRITE) | LBK-024 forced-native blockers | Native export accepted when required renderer unavailable | 409 plan response specified by blocked plan | `POST /api/exports/plan`, capability simulated through service | No exact blocker copy or implementation list | Lowest API rejection seam; E2E only runs with Remotion available |
| unit: needs-browser-download | LBK-024 warning | Export is blocked or fails to warn before browser download | `hybrid` plus `BROWSER_DOWNLOAD` from spec | `planExport` with injected capabilities | Independent of blocker wording/order | Lowest seam for simulated host state; unavailable route case covers different state |
| unit: effect order warning | LBK-010 stack-order warning | Colour-before-blur silently changes visual semantics | Warning vs no warning when order reverses, per spec | Exported warning helper called by extension | Checks semantics, not exact full string or internal scan | Lowest warning-rule seam; render E2E uses no blur after colour |
| unit: GC removes stale | LBK-021 cache TTL and route | Old cache persists, live cache disappears, or metadata is exposed | 14-day TTL, expected file existence and 200/404 route status | Service GC plus HTTP file route | Directory internals can change only if storage protocol changes | Lowest TTL/storage seam; E2E cache reuse does not advance 14 days |
| unit: GC keeps held entries (REWRITE) | LBK-021 review fix 4 lease safety | Active cache read is deleted or race returns missing path | Lease and lookup invariants from review fix | Service lease/lookup/GC, production methods | No patched queue.wait or parent job structure remains | Lowest race seam; real E2E does not force concurrent GC |
| unit: graded PNG route | LBK-010/021 signed per-frame URL | Wrong frame served, invalid frame accepted, or wrong content type | Known frame contents and 200/404 HTTP behavior | `GET /mg/layers/:key/graded.png` | Filename generation may change internally; endpoint semantics fixed | Lowest HTTP protocol owner; rendered E2E covers preview but not frame query validation |
| unit: capabilities (REWRITE) | LBK-030 feature schema | Clients cannot see state/cache size | Spec enum and numeric size | `GET /api/capabilities` | No private method patched | Lowest API schema seam; E2E uses readiness but not field shape |
| unit: preview validation | LBK-010 preview API | Invalid/missing/non-graphics clip starts a job or wrong error | HTTP status and error codes from API contract | `POST /api/layer-bake/preview` | No internal validator assertion | Lowest route seam; grade E2E checks valid preview path |
| primary E2E: hybrid parity (REWRITE) | LBK-001…005, §11 test 4 | Missing/clipped/incorrect title, shape or anime pixels | Separate full Remotion still render within specified tolerance | Public export job artifact; reference built from project snapshot and renderer service | No private `remotionProps` setup remains; checks pixels | Strongest critical render workflow; unit planner checks only path |
| primary E2E: straight alpha | LBK-003/010 review fix | Black/opaque edges around antialiasing or shadow | Browser PNG composited over four backgrounds within 2/255 | Real master output and real browser still | Compares output pixels, not codec flags | Strongest alpha-specific regression; hybrid parity over one background can miss it |
| primary E2E: cache reuse | LBK-020/021 | Moving title rerenders or text edit reuses stale bake | Actual child jobs and changed rendered placement | Public export job and decoded artifact | No key hash or internals | Strongest cache-use workflow; unit key tests input partition only |
| primary E2E: still path | LBK-025 | Still re-renders cached master or freezes an unseen animated frame | Still output matches export frame; one uncached frame bake | `POST /api/stills` job and PNG artifact | No private graph details | Only full still workflow here; export E2E cannot catch still-specific path |
| primary E2E: grade all paths | LBK-010/FIX-002 | Native, Remotion, or preview drops grade | Saturation zero yields grey glyphs; cross-path pixel tolerance | Public exports and preview route, decoded artifacts | No LUT/filter text assertion | Strongest colour parity owner; unit grade recipe does not prove visible pixels |
| primary E2E: graded static fade | LBK-010 review fix 1 | Fade missing/doubled or transparent area turns opaque | Midpoint opacity from transition duration, background alpha, pixel parity | Public exports and preview route, decoded artifacts | No private filter chain assertion | Only cross-path fade regression; grade case samples full opacity |
| primary E2E: failing bake fallback | LBK-023 | Auto job fails or forced native silently falls back | `NATIVE_FALLBACK`/`LAYER_BAKE_FAILED` job results | Public export jobs and Remotion artifact, with injected bake failure | Does not assert private fallback call shape | Strongest failure workflow; duplicate stubbed unit removed |
| primary E2E: usage log (REWRITE) | LBK-026/LC-004 | Actual bakes missing from license log | File has at least fixture’s bake count and media/still purposes | Real job output plus persisted usage log | No direct logger invocation or GPL helper | Lowest real usage owner; direct-call unit removed |
| parallel E2E: parallel vs sequential (REWRITE) | LBK-022 | Concurrent bakes corrupt final frames or fail to overlap | Decoded output equals sequential mode, child-job time spans overlap | Public export jobs and MOV artifacts | No cache metadata/byte or browser counter shape | Strongest rendered concurrency workflow; mocked scheduler unit removed |
| parallel E2E: cancel (REWRITE) | LBK-022 abort propagation | In-flight child jobs keep running or fail after parent cancellation | Parent cancelled; child jobs settle cancelled/succeeded, never failed | Public job queue state after export cancel | No private sessions map assertion | Lowest full cancellation workflow; default unit abort test removed |

### Non-test seam audit

Deleted test code no longer imports the following production exports: `buildNativeGraph`, `BUNDLE_STAMP_FILE`, `RemotionService`, `layerBakeExtension` from these files, though other non-test production callers remain for graph/extension/service. `LayerBakeService.stats.browsers` appears only in the service and the removed E2E assertions; parent should evaluate removing that test-only counter along with `stats.joined` if no other callers. `LAYER_BAKE_BENCH` instructions in README and wp notes are now stale; this subtask was restricted to the three test files.

### Completed validation and scope

Pruned over 1,000 net lines in the three owned files. Default Vitest: 15 passed with browser cases gated. Engine typecheck and targeted Biome passed. Real-browser hybrid parity passed on five frames (shares 1.0000, 0.9996, 0.9993, 0.9995, 1.0000). Full parallel E2E passed 2/2 with pixel-identical output and cancel propagation (118.89 s). Final primary E2E passed 7/7 (107.45 s). `git diff --check` passed. No production file was edited in this subtask; parent removed unused service statistics and is fixing benchmark documentation.

## MCP tests

Scope: `apps/mcp/test` baseline, against `apps/mcp/src`, `docs/wp-notes/wp-mcp.md`, `docs/ARCHITECTURE.md`, and S01/S06/S07/S08/S09/S10/S11 specs. `KEEP` and `REWRITE` lines enumerate the six required items in order: **S** independent specification, **F** recognizable failure, **O** expected oracle, **I** public or stable interface, **R** refactor survival, **L** lowest owner. Risks and validation at end. A rewritten baseline case can contribute to a consolidated surviving case. No production behavior was changed to preserve tests.

### `apps/mcp/test/unit.test.ts`

- **KEEP** `prefers explicit URL/token (flags over env)`: S wp-mcp discovery precedence; F wrong engine/credentials; O fixed supplied URLs/tokens, independent of resolver; I `discoverEngine` connection boundary; R no candidate-array shape; L discovery unit, real stdio only tests runtime path.
- **KEEP** `reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries`: S wp-mcp runtime discovery; F connects to dead/stale process or loses token; O three independent runtime files and health answers; I discovery boundary; R no private candidate implementation asserted; L discovery unit, integration tests only live runtime file. Linux-only case now explicitly skipped elsewhere instead of silently passing.
- **KEEP** `falls back to the default dev port`: S wp-mcp documented fallback; F tool cannot find dev engine; O fixed host/port and health fake; I discovery boundary; R implementation may refactor; L discovery unit.
- **KEEP** `probeHealth rejects non-engine answers`: S engine health protocol/security; F connects to unrelated service on candidate port; O independent non-engine JSON; I health HTTP boundary; R no parse-call shape; L probe unit.
- **DELETE** `finds the engine bundle next to the server (checkout layout) or via JASPER_ENGINE_ENTRY`: optional `if(found)` can pass with no bundle; direct path-shape assertion. Real `--start-engine` integration owns launch behavior.
- **KEEP** `EngineLink reports an actionable error when nothing runs`: S wp-mcp missing-engine error contract; F client gets hang/ambiguous error; O explicit `ENGINE_NOT_FOUND` and `--start-engine` recovery; I `EngineLink.client()` caller boundary; R no private discovery shape; L connection unit.
- **KEEP** `withEngine re-discovers once after a network failure`: S wp-mcp reconnect rule; F one transient network failure loses task or replays indefinitely; O first client fails, second succeeds, exactly two observable invocations; I `withEngine` seam; R collaborator implementation may change; L lowest deterministic network seam.
- **KEEP** `a request that never answers ends with ENGINE_TIMEOUT instead of hanging`: S wp-mcp bounded wait and token privacy; F unbounded call or token leak; O finite abort + error code, independent of implementation; I guarded EngineClient/`withEngine` result; R no timer internals; L lowest deterministic timeout seam.
- **KEEP** `a write cut off mid-flight is reported, not retried (it may have been applied)`: S wp-mcp no blind write replay safety; F duplicate edit; O reset after write, one send, `ENGINE_CONNECTION_LOST`; I EngineClient/`withEngine`; R no fetch implementation detail; L deterministic unit, real engine cannot reliably force mid-flight reset.
- **KEEP** `a write that never reached the engine, and any read, stay retryable NETWORK errors`: S wp-mcp safe retry rule; F refused write/read misclassified as possibly applied; O `ECONNREFUSED`/GET reset and `NETWORK`; I guarded client requests; R no method layout; L deterministic unit.
- **KEEP** `maps tool, engine and transaction errors to isError results with hints`: S wp-mcp MCP JSON error protocol and recovery hints; F caller lacks code/hint; O supplied errors and documented code/hint, independent of map; I MCP `CallToolResult`; R no internal map shape; L error-serialization unit, integration checks separate live codes.
- **DELETE** `renders a compact timeline table with frames and timecodes`: asserts exact row/copy/layout and empty track inventory; `get_timeline` in public e2e and project formatting tests own real data, while exact copy is not independently required.
- **REWRITE** `builds engine ExportSettings from a preset`: S S04 export recipe and preset labels/quality; F wrong dimensions/codec/quality or output destination; O documented preset values and explicit override inputs; I stable build-settings seam used by MCP `start_export`; R independent of field-building steps; L smallest seam for preset translation, real export covers draft output only. Removed duplicate-ID inventory and unrelated timeline fixture.
- **REWRITE** `MCP_SERVER_VERSION matches package.json` → `the --version CLI reports the package version`: S package version is public CLI contract; F CLI displays stale version; O package manifest; I executed CLI stdout; R internal constant may change; L CLI unit. The old direct constant/source assertion was deleted.

### `apps/mcp/test/integration.test.ts`

All surviving cases use a real token-protected engine, MCP SDK client over stdio, and temporary project. Core case verifies a PNG and ffprobe-readable exported MP4 as artifacts. Baseline scenarios were consolidated as follows.

- **DELETE** `advertises tools, resources and prompts`: long tool inventory, description-length and schema-shape detector; actual tool calls, resource read and prompt retrieval below are stronger public owners. Read-only/destructive metadata is covered in `processing.test.ts` where approval is specific.
- **REWRITE** `finds the token-mode engine through runtime.json` → core workflow: S wp-mcp runtime-token discovery; F cannot connect/authenticate; O isolated runtime file and expected local port; I MCP `engine_status`; R no discovery call shape; L stdio/engine integration.
- **REWRITE** `never shows the engine token to the agent or in its log`: S wp-mcp security and token secrecy; F secret appears in status/list/error/stderr; O fresh random token absent from outputs; I MCP responses and process stderr; R implementation free; L stdio boundary where leakage reaches caller.
- **REWRITE** `creates a project and imports fixture media` → core workflow: S wp-mcp editing workflow; F media unavailable after import; O independently generated fixture and one imported item; I stdio tools; R no command internals; L end-to-end MCP workflow.
- **DELETE** `edits the timeline with the helper tools`: exact table formatting and chained split/trim/move covered at command/model level and `e2e/agent.spec.ts` for live MCP edits; no unique caller-visible contract left after core add/export workflow.
- **DELETE** `places clips frame-exactly on any track and adds transitions`: source frame conversion and geometry are covered by project command tests; public transition path is retained below. Old extra-track/table assertions were formatting/row checks.
- **REWRITE** `lists, updates, applies and removes transitions` → `creates, edits, applies defaults, and removes transitions through MCP`: S S10:TUI-060; F transition absent/incorrect type or not removable; O requested known cross dissolve, dip-to-black, duration and empty final list; I public MCP tools; R no helper formatting; L real MCP transition boundary, model tests own internal fitting. Fixture now supplies incoming source handle so expected duration is valid.
- **REWRITE** `render_frame returns a downscaled PNG` → core workflow: S wp-mcp PNG image-content contract; F no/wrong image; O requested 320 px, PNG signature/IHDR; I MCP image content; R renderer implementation free; L real MCP render boundary.
- **REWRITE** `exports with start_export + wait_for_job and the output passes ffprobe` → core workflow: S wp-mcp export workflow/S04; F job succeeds without playable file, wrong size/frame count; O 1 s at 30 fps and draft 1280×720 preset, ffprobe; I MCP tools plus filesystem artifact; R no planner internals; L full stdio export boundary.
- **DELETE** `cancel_job stops an export...`: raced cancel vs completion and accepted both outcomes, so could pass without cancellation. `apps/engine/test/jobs.test.ts` owns cancellation, partial-file and HTTP behavior; `templates.test.ts` owns MCP cancelled-job error mapping.
- **DELETE** `adds text, markers and motion graphics, and deletes clips`: mixed helper/copy assertions; text animation workflow below owns MCP text, `compositions.test.ts` owns motion graphic, `e2e/agent.spec.ts` owns marker/live transaction, project tests own clip deletion.
- **REWRITE** `lists text animations and animates text with add_text / set_text_animation` → `persists text animation changes...`: S S11:ANA-002/008; F animator missing/wrong duration in saved project; O requested slide-up/fade and 50 fps × 1 second = 50 frames; I MCP `add_text`/`set_text_animation` and document resource; R no helper call shape; L MCP-to-project animation boundary. Catalogue count and exact source summary deleted.
- **REWRITE** `render_frames returns one PNG contact sheet of evenly spread frames` → same animation/contact sheet case: S S11:ANA-004; F no sheet or wrong cell times; O requested [0,15,29] and PNG bytes; I MCP result; R grid layout may change; L real renderer boundary. Pixel-grid/coordinate assertions deleted.
- **DELETE** `render_frames shows a text animation move (REMOTION_E2E=1)`: conditional visual sample tied to cell coordinates, with stronger `e2e/anime-templates.spec.ts` and project/remotion tests for rendered animation; real MCP contact sheet artifact retained without this duplicate.
- **DELETE** `removes the animated text again`: cleanup-only, no independent assertion; temporary project is removed.
- **REWRITE** `add_shape adds rectangles and ellipses; get_timeline shows their geometry; describe_commands documents clip.addShape` → `stores a shape...`: S S11:SHP-008; F shape geometry not persisted or ellipse accepts invalid radius; O explicitly supplied size/radius and expected E_INVALID_PARAM; I MCP `add_shape` plus saved document; R no table wording/schema-example shape; L real MCP shape boundary. `e2e/shapes.spec.ts` owns keyed display behavior.
- **REWRITE** `apply_commands: transactions, dry runs and every describe_commands example` → `dry runs leave the project unchanged...`: S wp-mcp dryRun protocol; F preview mutates revision; O before/after revision plus requested marker; I MCP tools; R command catalogue may change; L end-to-end transaction boundary. Every-example loop compared fixtures to their own implementation and was deleted.
- **REWRITE** `returns actionable tool errors` → destructive approval case: S S01 AGT-011 and wp-mcp; F destructive headless change proceeds; O E_APPROVAL_DENIED and no editor session; I MCP error result; R no exception internals; L MCP approval boundary. Other error list duplicated engine/project tests.
- **REWRITE** `serves resources and the edit-video prompt`: S wp-mcp resource/prompt URIs; F client cannot read project or prompt omits user goal; O known project ID and supplied goal; I MCP resource/prompt protocol; R server internals free; L stdio boundary.
- **DELETE** `lists motion templates and previews one (native renderer permitting)`: conditional branch could pass without image when renderer unavailable; `templates.test.ts` owns MCP preview, `compositions.test.ts` owns real rendered motion graphic.
- **DELETE** `list_motion_templates: anime entries with renderer, native and a params summary`: inventory/field-shape assertions; `templates.test.ts` owns independently specified renderer/keyframe metadata.
- **DELETE** `add_motion_graphic places title-reveal; set_motion_graphic_params edits and keyframes it`: `templates.test.ts` owns MCP parameter validation/keyframes and `e2e/anime-templates.spec.ts` owns real render/export artifact.
- **DELETE** `render_motion_graphic_preview validates anime params without rendering`: duplicate of `templates.test.ts` public invalid-params case.
- **DELETE** `previews an anime template and renders the timeline with Remotion (REMOTION_E2E=1)`: conditional return on unavailable renderer and duplicate rendered outcome; `e2e/anime-templates.spec.ts` validates real Program/export against renderStill; templates suite owns MCP preview error/success response.
- **REWRITE** `starts a headless engine when none is running and stops it on exit`: S wp-mcp `--start-engine` lifecycle; F engine never starts or remains after client close; O isolated appdir, expected port/runtime file creation/removal; I CLI MCP client; R no fork implementation assertion; L full CLI lifecycle. Removed branch that silently returned when a default-port engine answered.

### `apps/mcp/test/anime-contracts.test.ts` / `apps/mcp/test/readme-tools.test.ts`

- **DELETE** `are registered and keep the tool list and instructions well-formed`: tool/guide inventory and whitespace assertions; real MCP animation/shape tool calls above own user behavior.
- **DELETE** `lists every registered tool and states the right count`: registry-derived list compared with README copy is a change detector; no stable behavior or independent expected names. Public tool calls own actual availability.

### `apps/mcp/test/animation.test.ts`

- **DELETE** `lists every preset with its default length and a compact params summary`: registry declaration restated; MCP animation workflow owns usable presets.
- **DELETE** `is served by the MCP server without an engine, and the guide is in the instructions`: tool/copy inventory; real MCP calls own availability.
- **DELETE** `maps preset ids and converts seconds at the sequence rate`: private conversion result; 50 fps public MCP case above owns rate conversion.
- **DELETE** `loads the document only when a side gives seconds`: private collaborator call-count, no caller-visible contract.
- **DELETE** `converts seconds at the rate of the sequence the transaction targets`: fake connection/private helper; 50 fps real MCP resource readback owns the observable rate requirement.
- **DELETE** `labels the History entry by side`: exact copy/private helper; no wording requirement.
- **DELETE** `spreads frames evenly over [from,to) with both ends included`: duplicate public `render_frames` cell times above.
- **DELETE** `shrinks cells so the sheet stays within the size cap`: geometry/helper assertion; real contact sheet artifact owns usable output.
- **KEEP** `decodes RGB and RGBA rows of every filter type`: S PNG wire format; F external PNG with standard filter fails; O independent fixture bytes and expected RGB(A); I stable PNG decoder; R codec internals can change; L real MCP self-encoded PNG cannot test external filters.
- **KEEP** `decodes greyscale (with alpha) to RGBA and rejects what it does not support`: S PNG color/bit-depth protocol; F standard greyscale external PNG corrupts or invalid input accepted; O independent greyscale fixture and invalid bytes; I decoder; R internals free; L codec unit for formats real MCP does not generate.
- **DELETE** `round-trips through encodePng`: encoder and decoder can share same bug; no independent oracle.
- **DELETE** `composes a grid of cells with gaps over the background, alpha blended`: private pixel geometry; public `render_frames` PNG owns artifact.
- **DELETE** `shows text animators as in:<preset> out:<preset> and the anime renderer of templates`: exact text formatting; MCP animation document owns state, templates suite owns renderer.

### `apps/mcp/test/color.test.ts`

- **DELETE** `maps every Lumetri param exactly once and describes the registry ranges`: registry compared with itself.
- **DELETE** `rejects unknown fields and malformed curves/wheels; accepts nulls for LUTs and curves`: private GradeClipSchema export; malformed input contract rewritten into public `grade_clip` invalid-input assertions below.
- **DELETE** `clamps to the registry ranges and reports what was clamped`: private normalization shape; public grading case owns clamping.
- **DELETE** `resolves LUTs by id or name and refuses non-LUT media`: private resolver; public `grade_clip` with imported LUT name plus `get_grade` readback owns name alias, and negative MCP case owns invalid LUT.
- **DELETE** `re-times keyframes to keep their offset from the clip start`: project retime algorithm at wrong package seam; public copy/readback workflow below owns MCP copy state.
- **DELETE** `replaces the colour effects of the targets, keeps other effects and applies in one transaction`: private planned command details; public copy/render workflow below owns visible result.
- **DELETE** `advertises the colour tools with ranges and the order of operations`: registry/guide inventory; public tool calls below own availability.
- **KEEP** `imports a .cube LUT and reports the broken one with its line number`: S S06:CGA-002/acceptance #2; F missing imported LUT or unhelpful invalid-file error; O independent .cube fixture and known invalid line; I MCP `import_lut`; R parser internals free; L MCP exposure, engine owns parser.
- **REWRITE** `grade_clip grades in one Agent change and render_frame shows it`: S S06 acceptance #8; F grade not applied or not rendered; O before/after independent ffmpeg-decoded pixels plus event, malformed inputs and clamping requirements; I MCP tools and PNG; R no helper command shape; L real MCP grading boundary.
- **KEEP** `get_grade returns the evaluated values and LUT names`: S S06:CGA-002 read API; F stale/wrong grade or LUT metadata; O previous request and imported LUT fixture; I MCP `get_grade`; R internals free; L MCP readback, engine owns evaluation.
- **KEEP** `keyframed params need a time: rejected without one, keyed at at`: S S06:CGA-001/002; F invalid keyframe accepted or wrong evaluated frame; O chosen key times/values; I MCP tools; R command internals free; L MCP policy boundary.
- **REWRITE** `instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change`: S S06:CGA-002 copy/new semantics; F old grade persists or target render wrong; O chosen source/target grades and independent image delta; I MCP tools and PNG; R internal effects may change; L MCP copy boundary.

### `apps/mcp/test/tracking.test.ts`

- **DELETE** `lists the tracking tools with render_frame guidance`: tool and exact copy inventory; workflows below own actual use.
- **REWRITE** `add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth`: S S09:TRA-001/002 acceptance #7; F overlay visibly displaced; O independent fixture JSON corner truth at frames 20/75/130, 3 px tolerance; I MCP workflow plus ffmpeg-decoded PNG; R tracker internals free; L full MCP tracking/render boundary. PNGs saved under `test-results/mcp`.
- **REWRITE** `set_corner_pin places corners in sequence pixels`: S S09:TRA-001 accepts sequence pixels and normalized coords; F wrong corner normalization/pin; O 192/1920 and 108/1080 independent calculation; I MCP tool; R algorithm free; L manual MCP pin boundary. Removed normalized-input echo.

### `apps/mcp/test/transitions.test.ts`

- **DELETE** `describes a two-sided transition: cut, span, handles and what the span uses`: private summary shape/geometry; lean real MCP list/update/remove case above owns transition usability.
- **DELETE** `describes fades as one-sided with a fixed alignment and one clip handle`: private formatter object, duplicate project-model transition tests.
- **DELETE** `lists in track order then time, filtered by range`: private sort/row order; no independent user contract for exact row ordering.
- **DELETE** `marks transitions whose clips are gone or whose effect is unknown`: fabricated invalid state and defensive copy, no specified public behavior.
- **DELETE** `adds linked partners of the requested media`: private helper count; real MCP default-transition case owns application to a clip; project model tests own link expansion.
- **DELETE** `accepts short type names and effect ids`: private alias function, no independently specified alias contract.
- **DELETE** `lists transitions per track with span, alignment and length`: exact table copy/geometry; MCP transition state above owns presence/type/duration.

### `apps/mcp/test/shapes.test.ts`

- **DELETE** `describes geometry and paint compactly`: exact formatter copy; public shape document state in integration owns geometry.
- **DELETE** `lists keyframed properties`: exact formatter text; project/e2e shape keyframe behavior owns state.
- **DELETE** `prints the keyed values, not the stale static value, once a property is keyframed`: public regression is already owned by `e2e/shapes.spec.ts` lines 344-351, which reads the keyed range through MCP after applying the keyframe; isolated formatter duplicates that stronger owner.

### `apps/mcp/test/clipboard.test.ts`

- **REWRITE** `copy_clips → paste_clips across projects (linked pair, media added once, new ids)`: S S01:CLB-008; F missing cross-project media, wrong placement, or reused clip identity; O 1 s at 30 fps, source fingerprint and fresh-ID rule; I MCP copy/paste and saved project; R command implementation free; L MCP workflow, project tests own internal paste algorithm.
- **REWRITE** `copy_items → paste_items deep-copies a sequence into a bin`: S S01:CLB-007/008; F lost sequence/bin or content; O source text `Hi` and target bin specified by request; I MCP tools/saved project; R no private command shape; L MCP workflow.
- **DELETE** `the guide names the tools and the commands`: self-check of guide copy; public workflows own tool availability.
- **DELETE** `every clipboard example validates against a project with a clip on V1 at 0`: source example fixture/implementation restatement; project command validity tests and actual MCP clipboard workflows are stronger.

### `apps/mcp/test/compositions.test.ts`

- **DELETE** `summarizes a props schema for agents (type, default, constraints, controls)`: private propsSummary shape; real import/list MCP workflow below owns caller information. `propsSummary` export stays because production animation module imports it.
- **REWRITE** `imports, places, edits and renders a composition; errors carry hints`: S S08:MGA-001/002 acceptance §8 #7; F import/list/place/edit/render/prerender failure or wrong version hint; O independent Title/Badge fixture, 90-frame spec, title change in real PNG, master MOV; I stdio MCP plus real engine and artifacts; R no private call shape; L MCP composition integration, engine owns render internals.

### `apps/mcp/test/processing.test.ts`

- **REWRITE** `advertises the processing tools and guide` to assert only destructive metadata: S S07:PRA-001 approval requirement; F SDK caller misses destructive hint; O explicit security requirement; I MCP tools/list annotations; R registration structure free; L protocol metadata boundary.
- **KEEP** `lists the bundled SPAN model with its licence`: S S07:PST-032 and README licence; F missing model or attribution; O documented CC-BY-4.0/Philip Hofmann; I MCP `list_processing_models`; R backend internals free; L MCP model exposure (engine tests use fake catalog).
- **KEEP** `test_remote_executor without settings is a clear "not configured" error`: S S07:PRM-003/PRA-001; F opaque/wrong error or settings leak; O `REMOTE_NOT_CONFIGURED` and null settings; I MCP; R internals free; L MCP translation boundary.
- **KEEP** `set_processing_settings needs the user in an open editor`: S S07:PRA-001 security; F headless settings mutation; O `E_NO_SESSION` and unchanged remote settings; I MCP tools; R approval internals free; L MCP approval boundary.
- **REWRITE** `process_clip (denoise, local, replace, wait) swaps the clip to the processed version`: S S07:PRA-001/002; F no derived asset or clip still points to old version; O original media ID, processed ID, saved source and derivation; I real MCP/engine persisted project; R job/command shape free; L MCP processing workflow.

### `apps/mcp/test/templates.test.ts`

- **REWRITE** `reports renderer, native and a compact params summary with keyframable flags`: S S11:ANA-003; F wrong renderer/native/keyframe metadata; O independent template fixture JSON schema and anime-vs-fframes rule; I MCP `list_motion_templates`; R summary helper free; L MCP response.
- **DELETE** `the tools and the guide mention anime templates and set_motion_graphic_params`: inventory/copy, public template calls below own availability.
- **DELETE** `summarizes nullable, unbounded and unknown schema shapes`: helper format/examples, no independent user requirement; public summary above owns relevant fields.
- **REWRITE** `renders a one-clip document through the still path and returns the PNG`: S S11:ANA-003; F wrong template/params or no image; O supplied title/size and PNG signature; I MCP response plus engine requestStill document; R helper free; L MCP-to-engine preview boundary.
- **REWRITE** `returns intro, hold and outro frames with frames: 3`: S documented wp-m2-anime-templates regression #3; F outro omitted; O independent 25 fps/2 s frames [15,32,42]; I MCP multi-image output and still-request frames; R helper free; L public preview regression.
- **DELETE** `previewFrames samples the template phases (outro included), compressed like animeTemplateTiming`: private algorithm duplicate of preceding public regression.
- **DELETE** `reports the still path that drew the preview (hybrid included)`: mock returns exactly asserted hybrid; no independent output behavior.
- **KEEP** `rejects invalid params with E_INVALID_PARAM before rendering`: S S11:ANA-003 schema validation; F illegal params render; O fixture schema for titleSize and unknown keys; I MCP error + absence of still request; R helper free; L MCP validation.
- **KEEP** `keeps RENDERER_UNAVAILABLE for fframes templates`: S S11:ANA-003 renderer distinction; F wrong renderer call/error; O documented exact code; I MCP; R internal path free; L MCP fframes branch.
- **KEEP** `explains a failed still (Remotion unavailable) with the Remotion hint`: S S11:ANA-005; F no actionable browser/build recovery; O injected failure and documented env keys; I MCP error; R hint implementation free; L MCP preview failure boundary.
- **DELETE** `builds the preview document with the catalogue entry as registry`: internal snapshot duplicate of public preview case.
- **REWRITE** `sets static params with one clip.update (merged, one Agent transaction)`: S S11:ANA-003; F requested static values lost/default not merged; O user request and template default fixture; I MCP clip response; R command shape free; L MCP static-edit boundary.
- **REWRITE** `keyframes numeric and colour params of anime templates (setAnimated + set at the frame)`: S S11:ANA-003; F wrong keyframe or static title/non-keyframable title accepted; O requested values/time plus fixture keyframability; I MCP response and persisted project; R command sequence free; L MCP keyframe boundary.
- **REWRITE** `validates the clip, the param names, values, times and the renderer`: S S11:ANA-003; F illegal edit accepted or project mutated; O fixture schema and specified error cases; I MCP and saved document; R internals free; L MCP edit validation.
- **DELETE** `dry runs change nothing`: the fake engine itself implements dryRun and returns unchanged state, while real-engine `integration.test.ts` now verifies dryRun leaves the project revision unchanged; duplicate at a mocked layer.
- **DELETE** `planParamCommands keeps fframes params static`: private command shape, public validation case owns fframes behavior.
- **DELETE** `renderHint maps the codes`: private helper and production constants as oracles; public endpoint error cases below own recovery.
- **REWRITE** `render_frame: TEMPLATE_NOT_INSTALLED and a missing browser`: S S11:ANA-005; F missing template/browser recovery; O documented action/env key; I MCP; R helper free; L frame endpoint.
- **REWRITE** `start_export: plan errors and Remotion warnings carry hints; the happy path skips capabilities`: S S11:ANA-005; F blocker/browser warning omitted; O injected engine error + documented recovery; I MCP; R internals free; L export endpoint.
- **REWRITE** `wait_for_job: a failed export explains Remotion; cancelled jobs get no hint`: S S11:ANA-005; F failed job lacks browser recovery or cancelled job gets misleading hint; O job statuses + documented recovery; I MCP; R helper free; L job endpoint.

### Removed support, risks, validation

- Removed `apps/mcp/src/discovery.ts` option `noDefaultPort`, whose only caller was unit tests; the unit fake transport already rejects the default port. Removed comment claiming `version.ts` was synced by a private constant test, since the CLI is now tested.
- Removed test-only `GradeClipSchema` declaration/export and unneeded exported color helpers (`GradeSection`, `GRADE_FIELDS`, `rangeText`, `GradeClipInput`, `Clamped`, `normalizeGrade`, `resolveLut`, `resolveLutRefs`, `planCopyGrade`). These remain internal where production needs them; no non-test imports used the exports.
- Removed test-only template exports `paramsSummary`, `animePreviewDocument`, `previewPhases`, `previewFrames`, `planParamCommands`; production still calls them internally. Kept `propsSummary`, guide exports and command examples because production imports them.
- Eliminated `sampleDoc` and associated transaction fixture from unit tests, two deleted test files, and cleanup-only integration state; no snapshots found.
- Material limits: the 50 fps text test uses a distinct 50 fps project rather than two sequences in one project; it catches default-rate misuse but not every wrong-sequence lookup. Optional `REMOTION_E2E=1` template visual render was deleted because browser e2e owns that artifact; its result depends on installed browser/bundle. The `--start-engine` case now fails if another engine occupies the documented fallback port rather than silently passing; CI should isolate that port. Exact transition summary ordering and formatter copy no longer have isolated checks because no independent contract justifies them.
- Focused validation: `pnpm exec vitest run apps/mcp/test/unit.test.ts apps/mcp/test/integration.test.ts` **20 passed**; animation 2/2, color 5/5, tracking 2/2; clipboard/templates focused tests passed; processing 5 passed; composition with `MG_E2E=1` 1 passed (real render/prerender). MCP typecheck, Biome on touched files, `git diff --check` passed. Full repo gates and remote synchronization remain with root agent.

## Engine color and audio

Scope: `apps/engine/test/color.test.ts`, `color-remotion.test.ts`, `audio-crossfade.test.ts`; owners inspected: `apps/engine/src/color/{prober,extension}.ts`, `routes/color.ts`, `remotion/service.ts`, `export/native.ts`, and S06/S10 specifications. Before editing, 12 named tests existed. After editing, 11 named tests remain. The old graph test was rewritten as a rendered constant-gain test, and the private Remotion helper test was deleted. All other named tests retain their external contract with narrower assertions. No test-only fixture or snapshot became unused.

Validation command: `pnpm vitest run --project @jasper/engine apps/engine/test/color.test.ts apps/engine/test/color-remotion.test.ts apps/engine/test/audio-crossfade.test.ts` (10 passed, 1 gated); `REMOTION_E2E=1 pnpm vitest run --project @jasper/engine apps/engine/test/color-remotion.test.ts` (2 passed); Biome and `git diff --check` on assigned files passed. Engine typecheck passed after concurrent warp edits settled.

## Baseline test dispositions

1. **REWRITE** `color.test.ts` — `registers a vendor-style 33³ .cube as kind lut with its header`. Removed the empty `probe.streams` shape assertion and changed the file-serving check to compare the HTTP response bytes to the registered fixture. Contract/failure: S06 LUT-001/003 requires 3D `.cube` registration with the title/domain/size header and immutable `/media/<key>` access; wrong metadata or corrupted serving fails. Independent oracle: authored fixture header and bytes, not prober code. Seam: media registration response and GET endpoint. Refactor survival: parser, registry, and storage may change. Lowest owner: this engine integration uniquely connects registration with serving; project LUT parser tests do not cover HTTP registration or bytes.

2. **KEEP** `color.test.ts` — `registers a 1D LUT (LUT-004)`. Contract/failure: S06 LUT-004 permits per-channel 1D `.cube`; an import rejection or wrong dimensions/size/title breaks the media picker and fails. Independent oracle: authored 1D fixture header. Seam: media registration response. Refactor survival: file parsing and storage internals are not asserted. Lowest owner: the 3D test does not cover the distinct 1D dialect or engine registration.

3. **KEEP** `color.test.ts` — `rejects broken files with the parser line number`. Contract/failure: S06 LUT-001 requires invalid imports to report a line-numbered error; accepting corrupt cubes, wrong error code, or misplaced line fails. Independent oracle: malformed fixture lines 7 and 6 and specified `INVALID_LUT` code. Seam: `/api/media/register` error response. Refactor survival: parser/error plumbing may change. Lowest owner: only this test verifies line-aware engine import errors; project parser tests cannot cover HTTP error mapping.

4. **REWRITE** `color.test.ts` — `reports features.color (lut3d in the engine ffmpeg)`. Removed an enum-membership inventory assertion for `remotionWebgl`; retained the `lut3d: true` public capability. Contract/failure: S06 CG-042 defines `features.color`; a missing or incorrect native `lut3d` capability misleads clients and fails. Independent oracle: known vendor FFmpeg fixture/environment with `lut3d`, rather than implementation logic. Seam: `/api/capabilities` response. Refactor survival: probing and provider implementation may change. Lowest owner: render parity cannot detect a wrong advertised capability.

5. **REWRITE** `color.test.ts` — `a statically graded clip plans native; the builder uses one lut3d and no GPL filter` (now `plans graded clips natively without GPL-only filters`). Removed exact LUT count/path/regex assertions, the scanner self-test, and redundant fusion counts. Contract/failure: S06 CG-053/054 and Architecture D-13 require the native path and forbid named GPL-only FFmpeg filters; a planner block or forbidden emitted filter fails. Independent oracle: spec/architecture filter denylist and path requirement, not extension constants. Seam: public export plan plus generated FFmpeg command bytes (external process protocol). Refactor survival: the filter graph can be reordered, fused, or renamed internally if it remains LGPL-safe. Lowest owner: decoded PNG parity does not check licensing of the command, and project color tests cannot see native planning.

6. **REWRITE** `color.test.ts` — `keyframed grades: ≤ 30 lut3d windows over 30 frames; frames 0 and 29 match the start/end stills` (now `keyframed export frames match the start and end grades`). Removed prepared LUT windows, internal filter count, enable-string, and separate planner assertions. Contract/failure: S06 §9(5) requires animated grade endpoints in native export to match independently constructed static grades; a stale, swapped, or missing keyframe changes decoded pixels and fails. Independent oracle: two separately authored static grade documents and their still images, not the export's prepared windows. Seam: export API and decoded MP4/PNG frames. Refactor survival: LUT windowing, quantization, and filter graph can change while final pixels remain correct. Lowest owner: static still parity does not test animation or export frame selection.

7. **KEEP** `color.test.ts` — `native still parity with the TS reference on the chart (S06 §9 test 3: ≤ 2/255 on 99.5 %, max ≤ 4)`. Contract/failure: S06 §9(3) specifies the pixel tolerance and native path; wrong LUT bake, sampling, or rendering changes decoded PNG pixels and fails. Independent oracle: source chart plus S06-specified TypeScript `applyLut` reference; the expected image is computed separately from engine rendering. Seam: still API and decoded PNG. Refactor survival: export builder, FFmpeg invocation, and cache representation can change. Lowest owner: this is the native renderer parity owner; project math tests do not render through FFmpeg.

8. **DELETE** `color-remotion.test.ts` — `detects colour effects in a render doc`. It directly called a private render-document walker and asserted its traversal shape. It had no caller-visible result, failed the stable-seam and refactor bars, and duplicated the actual `WEBGL_UNAVAILABLE` integration test. No real behavior became unprotected. Its test-only `docHasColorEffects` export was removed; the runtime-local function remains.

9. **REWRITE** `color-remotion.test.ts` — `an engine without WebGL2 fails a graded Remotion still with WEBGL_UNAVAILABLE`. Removed a duplicate plan-shape query and asserted the accepted still request before the job error. Contract/failure: S06 CG-042 forbids silently ungraded Remotion output without WebGL2 and mandates `WEBGL_UNAVAILABLE`; a wrong or successful job fails. Independent oracle: specified error code under explicit `JASPER_REMOTION_GL=off`, not helper output. Seam: still HTTP/job API. Refactor survival: planner and effect detection internals may change. Lowest owner: browser parity runs only when WebGL exists; this uniquely covers the unsupported-host failure.

10. **KEEP** `color-remotion.test.ts` — `a graded chart + (blank) text still matches the TS reference (≤ 2/255 on 99.5 %)`. Contract/failure: S06 §9(6) requires a graded Remotion render of a mixed sequence; missing or wrong browser color stage changes decoded PNG pixels and fails when WebGL is available. Independent oracle: authored chart/look fixture plus spec-designated TS grade reference, computed independently of browser output. Seam: listening engine's still HTTP API and retrieved PNG artifact. Refactor survival: browser pipeline, component tree, shader/CPU stage, and bundle internals may change. Lowest owner: native still parity cannot catch Remotion-only color failure. Environment gate: `REMOTION_E2E=1`; if WebGL is unavailable it verifies the specified error instead. The generated PNG remains in a `jasper-color-rem-*` temporary directory for inspection.

11. **REWRITE** `audio-crossfade.test.ts` — `plays the handles and writes an afade out / in pair over the span` (replaced with `exports a constant-gain crossfade with half of each tone at the cut`). Removed snapshot handles, exact `afade` text, seeks, sample counts, and private graph inputs. Contract/failure: S10 TUI-052 specifies the linear constant-gain law; an incorrect quarter-sine curve or missing handle makes each tone's decoded midpoint amplitude differ from half of full strength. Independent oracle: physical amplitudes of two authored sine tones and the specified linear gain law. Seam: exported MP4 decoded to PCM. Refactor survival: native command composition and filters may change. Lowest owner: project gain tests do not cover native rendered samples, while the remaining power test exercises a different law.

12. **REWRITE** `audio-crossfade.test.ts` — `exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB`. Extracted shared export setup; retained decoded audio checks. Contract/failure: S10 TUI-052/§8(7) requires two-sided handle playback and a constant-power law; silence, a bump/dip, swapped tones, or absent handles changes RMS or per-tone amplitudes and fails. Independent oracle: authored 1000/1500 Hz sources, 20 ms physical RMS windows, and quarter-sine law from the spec, not native graph arguments. Seam: export HTTP/job API and decoded MP4 audio. Refactor survival: seek/trim/filter implementation may change. Lowest owner: project and composition tests cannot prove audible native output; the constant-gain test covers a distinct law.

## Support and production seams removed

- Removed `gplFiltersIn` and its `GPL_FILTERS` constant from `apps/engine/src/color/extension.ts`. They had zero production callers. The S06 CG-054 check now holds its independent LGPL denylist within the native-plan test; the layer-bake test owner removed its uses separately.
- Made `docHasColorEffects` private within `apps/engine/src/remotion/service.ts`; the runtime still calls it. No production behavior changed.
- Removed audio graph setup/helper code and unused color prepared-window imports. No fixture, snapshot, or helper file became unused in this assigned scope.

## Engine warp and tracking

Baseline paths: `apps/engine/test/warp-unit.test.ts`, `apps/engine/test/warp.test.ts`, `apps/engine/test/tracking-unit.test.ts`, `apps/engine/test/tracking.test.ts`, and `apps/engine/test/tracking-bundle.test.ts`. The unqualified names in the disposition tables resolve against these paths.

Scope: baseline `apps/engine/test/{warp*,tracking*}.test.ts`, including the deleted `tracking-bundle.test.ts`. Inspected production owners in `apps/engine/src/{tracking,export/warp,export/native.ts}`, S09 (`docs/specs/09-tracking.md`), and architecture D-13/D-28 and §19.5/19.6. Original: 48 tests (tracking-unit 15, tracking 12, tracking-bundle 2, warp-unit 10, warp 9). Final: 23 (2 + 10 + 0 + 3 + 8), a reduction of 25. Focused files changed by this agent only; no commit/push by subagent.

## Survivors: all six bar items per test

Table columns: **source** = independent requirement, **failure** = recognizable user/caller failure, **oracle** = expected result outside the implementation under test, **seam** = public or stable observer, **refactor** = behavior-preserving refactor survival, **owner** = lowest stable distinct coverage. Unless called out, source is S09 and the seam is the engine HTTP route (stable API), so changing private service classes or call shape leaves the test valid.

| Disposition / path / baseline test | Source | Failure | Independent oracle | Seam | Refactor | Distinct owner |
|---|---|---|---|---|---|---|
| REWRITE `warp-unit.test.ts` identity image/transparent outside | TRK-032 pixel contract | Overlay shifted or leaks pixels | Literal 2-pixel RGBA image and expected uncovered zero | Worker kernel's pixel buffer, used by pool | Kernel implementation and threading can change | Lowest seam for individual sample semantics; still render's compression hides exact alpha |
| REWRITE `warp-unit.test.ts` half-pixel premultiplied sample | TRK-032 bilinear/premultiplied rule | Black halo on translucent overlay | White opaque plus black transparent source gives white at half alpha | Kernel pixel buffer | Interpolator internals can change | Only precise translucent-edge oracle |
| REWRITE `warp-unit.test.ts` opacity and BT.709 YUVA | TRK-032 ProRes input/color | Wrong opacity or chroma in export | Numeric BT.709 TV-range red and 10-bit alpha specified by format | Kernel encoded input buffer | Can replace converter and worker plumbing | Export parity checks RGB after video compression and cannot isolate 10-bit YUVA |
| REWRITE `tracking-unit.test.ts` selected bezel edge | TRK-012 optional edge refinement + screen replacement goal | Tracker jumps 10 px to stronger outer bezel edge | Independently generated luminance plate with known quad and chosen inner edge | Image-to-quad refinement seam used by worker | Sampling/fitting internals can change | Main tracker fixture lacks nested stronger bezel edge |
| REWRITE `tracking-unit.test.ts` edge outside frame | TRK-012 track clipped screen and return position | Quad jumps when one side exits frame or chases far edge | Known drawn quad and known out-of-frame side | Image-to-quad refinement seam | Fitting internals can change | Main tracker fixture does not have missing side; removed private `sides.accepted` assertions |
| KEEP `tracking.test.ts` unknown media key | TRK-010 API | Unknown source accepted or wrong status/code | 404 `ASSET_NOT_FOUND` protocol | HTTP | Service implementation independent | Only route-specific missing-source case |
| KEEP `tracking.test.ts` malformed bodies/geometry | TRK-010 API and convex/contained geometry | Invalid reference accepted, ambiguous error | 400 `VALIDATION_FAILED`, case inputs from schema and geometry rules | HTTP | Validator can change | Unit validation tests deleted; one boundary test at API |
| KEEP `tracking.test.ts` capability | §19.7 feature API and TRK-011 OpenCV | Client enables unavailable tracking or hides ready tracking | Public capability status/engine/warpStage shape | HTTP capabilities | Internal capability builder can change | Only tracking capability owner |
| KEEP `tracking.test.ts` exact seek, system ffmpeg | TRK-011 source-frame decoding | Tracking offset after seeking into video | Independent frame numbers burned in fixture | Decoder's decoded frame bytes, stable media seam | ffmpeg argument construction can change | Catch seek bug before tracker; redundant arg-shape unit deleted |
| KEEP `tracking.test.ts` exact seek, vendor LGPL ffmpeg | D-13 shipped LGPL build + TRK-011 | Distributed binary seeks wrong frames | Same burned frame-code fixture | Decoded frame bytes using packaged binary | Argument construction can change | Only distinct vendor binary decode check; full vendor tracker duplicate deleted |
| KEEP `tracking.test.ts` planar both directions, accuracy/live progress | TRK-010/012 + S09 §8.2 | Tracked corners wrong, not live, failed recovery | Generated fixture's per-frame ground truth and occlusion list | HTTP job result + broadcaster event | OpenCV algorithm/worker internals can change | Canonical full planar workflow; lower unit math/protocol probes deleted |
| KEEP `tracking.test.ts` forward/out-of-media span | TRK-002/010 | Forward samples misaligned or end-of-media yields bad sample | Reference frame 140, frameCount 150, specified lost/hold rule | HTTP job result | Worker/decoder refactors allowed | Main both-direction case does not cross media end |
| KEEP `tracking.test.ts` backward surroundings | TRK-012 ring features and direction | User's backward/surroundings track is wrong | Generated ground truth on frames 5–20 | HTTP job result | Feature-selection internals can change | Main case uses inside features and a mid-reference; distinct option |
| KEEP `tracking.test.ts` point both directions | TRK-013 + S09 §8.2 | Point drifts or disappears | Generated point path, 1 px RMS budget | HTTP job result | Tracker algorithm can change | Only point accuracy owner |
| KEEP `tracking.test.ts` cancel <500 ms | TRK-014 | Stop does not stop job promptly | Contractual 500 ms and cancelled job state | HTTP cancel + job result | Worker signalling can change | Warp cancel concerns export, not tracking job |
| KEEP `warp.test.ts` native planner positive | TRK-032 + S09 §8.5 | Corner pin/Motion unnecessarily falls back | Native path for explicit sequence cases | HTTP export plan | Native extension internals can change | Cheapest stable planner seam |
| KEEP `warp.test.ts` unsupported effects planner | §19.6 support matrix | Planner claims an effect it cannot render | Remotion path/blocker for blur or animated crop; text handled by layer bake | HTTP export plan | Extension dispatch can change | Positive planner does not catch unsafe claims |
| REWRITE `warp.test.ts` native export and cache | TRK-032/033 + §8.5 | Export fails/changes path, cache rewrites, intermediate has wrong format | HTTP result, on-disk file with artificially old mtime, ffprobe ProRes/alpha/BT.709 | Export HTTP + cache artifact | Internal stats/key layout can change | Canonical export/cache artifact; `WarpStats` removed as test-only seam |
| KEEP `warp.test.ts` generated LGPL filter list | Architecture D-13 explicit GPL filter ban | Shipped LGPL ffmpeg cannot execute render | D-13 banned filter names checked on generated builder/warp text | Generated ffmpeg command, stable integration boundary | Identifier and private refactors can change | Only end-to-end generated filter check after arg-shape unit deleted |
| KEEP `warp.test.ts` pinned-card position/color | TRK-034 | Native pin visibly differs from preview scene | Synthetic card colors and public scene quad, ≤1 px/3 levels | HTTP still artifact + scene resolver | Warp/pool/ffmpeg internals can change | Canonical pin parity; unit kernel cannot prove composited output |
| KEEP `warp.test.ts` animated Motion/opacity position/color | TRK-032/034 | Animated frame/alpha visibly wrong | Card colors at known mid-animation frame, ≤1 px/3 levels | HTTP still artifact + scene resolver | Internal interpolation/worker refactors can change | Pin test has static geometry/opacity; distinct animation |
| KEEP `warp.test.ts` composition layer override/missing master | Architecture §19.6 source-space contract | Warped composition reads wrong source or fails unclearly | Real fixture master and 20-frame intermediate; `WARP_SOURCE_UNAVAILABLE` error | Native extension API (documented in §19.6) plus ffprobe artifact | Extension implementation can change | Only composition-source edge case; mock supplies source but does not implement warp |
| KEEP `warp.test.ts` cancel mid-render | Job cancellation contract, TRK-032 render pipeline | Partial cache persists or child keeps running | `JOB_CANCELLED`, bounded completion, empty cache directory | Native extension prepare context (documented in §19.6) | Worker/ffmpeg internals can change | Export-specific cancellation; track cancel separate |

The two retained tracking refinement tests are isolated because a selected border may fail by snapping to a stronger neighboring border, by moving an unseen side, or by accepting a distant edge. Tests retain only those distinguishable output failures. The three retained kernel tests are isolated because sampling may shift the image, darken translucent edges, misapply opacity, or encode invalid YUVA. None of their expected pixels is computed by the function under test.

## Deletions (each baseline test)

| Path | Deleted baseline test | Reason / stronger owner |
|---|---|---|
| `tracking-unit.test.ts` | inverts, composes and maps points | Internal homography self-consistency; project math tests and HTTP ground-truth tracker own observable behavior |
| same | maps media px ↔ tracking px | Internal conversion roundtrip; planar/point HTTP fixtures across resolutions own geometry |
| same | detects convex quads and builds feature masks | Private mask array; HTTP invalid-geometry and surroundings tests own contracts |
| same | fits off = a + b·t through 30% outliers | Private fitter shape; edge refinement and HTTP accuracy stronger |
| same | intersects lines | Arithmetic helper, no independent user failure beyond edge/accuracy tests |
| same | planar confidence formula | Mirrors exact implementation formula; user contract is confidence/lost behavior checked at HTTP |
| same | snaps predicted quad to luminance steps | Simpler edge case duplicated by retained harder bezel regression |
| same | finds dark valley of a bezel mask | Duplicated by retained bezel regression with stronger competing edge |
| same | spans forward/backward/both | Private span structure; HTTP forward/backward/both tests |
| same | validates reference/range/geometry | Private validator and copy messages; HTTP 400 test |
| same | builds worker configurations | Private collaborator parameter inventory; HTTP tracker accuracy/capability |
| same | decodes with input seek half frame early | ffmpeg argument shape; actual frame-code seek test |
| same | loads OpenCV and tracks a translated texture | Private worker protocol with literal params; HTTP ground-truth planar/point tests |
| `tracking.test.ts` | TRK-014 host speed | Load-dependent test skips assertion and uses 12.5 vs specified 25 fps; can pass on slow machines for wrong reason. Spec budget remains a benchmark requirement, not verified by a reliable gate |
| same | full tracker with vendor LGPL ffmpeg | Duplicate full planar tracking; vendor exact-seek decoder and main HTTP accuracy cover distinct factors |
| `tracking-bundle.test.ts` | planar track from synthetic bundle | Private classes exported by fabricated stdin entry, not production bundle; actual built-engine UI E2E (`e2e/tracking.spec.ts`) and HTTP fixture accuracy are stronger owners |
| same | warp pool from synthetic bundle | Private class/slot shape with one alpha-byte probe; native HTTP warp still, plus built-engine workflows, own behavior |
| `warp-unit.test.ts` | source-chain is exactly builder head | Private filter graph parity/change detector; native export still/cache and GPL generated filter tests stronger |
| same | layer override/pickOverride call shape | Private source args/ordering; retained composition override artifact test |
| same | destRect projected box coordinates | Private optimization geometry; parity still confirms output pixels |
| same | claims layers by kind/animation | Private claims boolean; HTTP planner positive/negative tests |
| same | blockers/effect support/composition | Private blockers shape; HTTP planner and composition failure tests |
| same | per-frame map/inverse internal arrays | Private matrix representation; animated Motion/opacity still parity |
| same | ffmpeg decoder/encoder argument arrays | Private command shape; ffprobe artifact and generated GPL filter check |
| `warp.test.ts` | host warp speed | Up to three random re-renders, load-dependent 4/12.5 fps floor vs specified 25 fps; can pass without protecting speed budget; full native export remains |

## Production support and callers

Removed `WarpStats`/`stats` counters and redundant `WarpExtension` alias: no production callers (only deleted/rewritten tests), while per-render timing remains in production log. Removed test-only reexports from `export/warp/index.ts`. Made `pickOverride`, `trackSpan`, `validateTrackRequest`, `trackerConfig`, tracking `decodeArgs`, warp `encoderArgs`, `warpClaims`, `layerSpan`, `warpFrames`, and `threadedScalers` local: each remains used by its own production module; no other non-test import was found. Kept `layerSourceChain` because native builder and warp extension both call it, `createWarpExtension` because the route registers it, `warpFrame` because WarpPool calls it, `destRect` because the extension uses it, and geometry exports because worker source serialization consumes them.

## Risk and validation

Risks: speed budgets now require a controlled reference-machine benchmark; synthetic bundle-worker probe removed, with actual built-engine E2E the stronger deployment owner. Cache mtime assertion assumes filesystem `utimes` precision, validated locally. No production behavior changed; deleted only metrics and test-only export surfaces.

Validation: `pnpm --filter @jasper/engine exec vitest run test/warp-unit.test.ts test/tracking-unit.test.ts` -> 5/5 passed; `pnpm --filter @jasper/engine exec vitest run test/warp.test.ts test/tracking.test.ts` -> 18/18 passed; `pnpm --filter @jasper/engine typecheck` passed after final seam edits; `pnpm exec biome check` on the ten touched surviving TS files passed; `git diff --check` on touched files passed. Parent owns repo-wide lint/typecheck/test/build gates.

## Engine processing pipeline

Scope: the six engine test files processing-cli, processing-remote, processing-steps, processing, dejudder, and vidstab-wasm. Independent source: docs/specs/07-clip-processing.md §§4, 5, 8; docs/ARCHITECTURE.md D-13/D-25. Owners read before editing: processing service/routes, remote, settings, proc runner/filters/upscale, dejudder, vidstab. Small test command: pnpm exec vitest run followed by the six file paths. Engine typecheck: pnpm --filter @jasper/engine typecheck. Existing remote real-SSH case is opt-in by the spec. Heavy video tests require FFmpeg.

The six KEEP/REWRITE fields below are Source (independent), Failure (caller visible), Oracle (can disagree with code), Interface (stable observed seam), Refactor (behavior-preserving), Owner (lowest stable coverage). A grouped entry applies separately to every named test in it.

### apps/engine/test/processing-cli.test.ts

- KEEP cancels detached FFmpeg ignoring SIGTERM. Source PRC-011 cancellation; Failure orphan process/partial output or wrong exit code; Oracle deliberately resistant external child and OS PID/filesystem; Interface spawned jasper-proc CLI; Refactor signal handling can change; Owner unique resistant-child case, whereas processing.test.ts owns ordinary local API cancellation.

### apps/engine/test/processing-remote.test.ts

- DELETE builds argument arrays/options. Checks private SSH call shape and literal quote helper; shims/real SSH own observable protocol. A behavior-preserving transport refactor could break it.
- KEEP probe before setup. Source PRM-003; Failure false ready/GPU capability; Oracle fresh remote without runtime/GPU; Interface probe API; Refactor command construction can change; Owner unique pre-setup state.
- KEEP setup then probe ready. Source PRM-004/008; Failure setup job or runtime/provider capability wrong; Oracle remote files and later probe; Interface setup job and probe API; Refactor upload internals can change; Owner unique setup transition.
- KEEP auto remote, cache, cleanup; removed internal sidecar fields. Source PRM-005/007; Failure local fallback, cache miss, leaked job dir; Oracle job executor, remote filesystem and SSH command log after second recipe; Interface job API plus SSH-visible filesystem; Refactor job internals can change; Owner sole remote cache/process/cleanup flow.
- KEEP interrupted upload resumes. Source PRM-005/008; Failure partial lost or retry wrong bytes; Oracle deliberately aborted 24-MiB transfer and final source-byte comparison; Interface SshRemote.upload, lowest transfer seam; Refactor subprocess implementation can change; Owner only resume case.
- KEEP remote cancel. Source PRM-006/008; Failure live remote PID/dir after cancelled job; Oracle OS PID and remote filesystem; Interface job API and remote OS; Refactor execution mechanism can change; Owner only remote process-group cancel.
- KEEP broken connection. Source PRM-006/007; Failure local fallback or wrong retryable code; Oracle dead SSH shim exits 255; Interface job API; Refactor internals can change; Owner sole lost-connection path.
- KEEP real SSH opt-in. Source PRM-008 explicitly; Failure shim-only assumptions break real SSH; Oracle actual SSH host and completed process job; Interface API/SSH; Refactor shims can change; Owner only real transport case. Risk: no configured host in default gate.

### apps/engine/test/processing.test.ts

- KEEP model catalog install states. Source PST-031; Failure wrong installed flags; Oracle generated installed model plus absent model; Interface models API; Refactor catalog internals can change; Owner sole route owner.
- KEEP settings persistence/validation. Source PRM-001/009; Failure unsafe shell path accepted or settings lost; Oracle invalid metacharacter path and documented engine.json file; Interface settings API/storage; Refactor serializer can change; Owner sole persistence route case.
- KEEP unconfigured probe/setup. Source PRM-001/003/004; Failure remote operation runs or wrong code; Oracle fresh null remote; Interface remote routes; Refactor service internals can change; Owner sole unconfigured path.
- KEEP capabilities/licenses. Source PST-003/030/031 and public route schemas; Failure absent method/provider/license/pin; Oracle independently specified licenses and installed test model; Interface capabilities/licenses API; Refactor internals can change; Owner only processing route capability/license case.
- DELETE vid.stab pin mirrors manifest. Source/manifest comparison is a build change detector; scripts/vidstab-wasm/build.sh rejects disagreement, and ffmpeg:check protects shipped pin/license.
- KEEP unknown media/uninstalled model rejection. Source PRC-001/PST-031; Failure invalid process accepted; Oracle nonexistent key and known absent weights; Interface process API error code; Refactor internals can change; Owner sole validation route case.
- REWRITE denoise+deblock job to registration, derived storage record, proxy and reuse; dropped duplicate frame/rate/audio/ProRes facts, exact name/note and recipeHash() self-oracle. Source PRC-002/003; Failure derived version absent, original path leaked, proxy not queued, repeat recipe makes different media key; Oracle persisted record, jobs API, file probe, two submitted jobs; Interface job/media API and documented storage; Refactor filters/encoding can change; Owner processing-steps owns media invariants, this owns registration/reuse.
- KEEP upscale with range. Source PST-030/034 and range contract; Failure wrong 2x dimensions or 12-frame 25..37 range; Oracle ffprobe output vs source and submitted range; Interface process job/output artifact; Refactor model implementation can change; Owner only API range owner, runner owns tiling/mix.
- KEEP local cancel. Source PRC-011; Failure non-cancelled job or partial file left; Oracle running job transition plus filesystem; Interface job API and artifact; Refactor process launch can change; Owner local API cancel; CLI resistant-child case is distinct.
- KEEP derived version exports native. Source S07 §8 test 8; Failure blocker or export reads deleted original; Oracle remove source before successful native render; Interface export plan/job and artifact; Refactor export internals can change; Owner sole processed-version export workflow.

### apps/engine/test/processing-steps.test.ts

- KEEP LGPL filters. Source D-13/PST-003/020/021; Failure generated GPL filter accepted or vendor FFmpeg lacks required filter; Oracle real binary filter list plus named forbidden examples; Interface FFmpeg binary/filter guard used by runner; Refactor graph generation can change; Owner lowest license guard, packaging gate separately checks build license.
- KEEP all eight frame-count/rate/audio cases: deblock, denoise-atadenoise, denoise-fftdnoiz, stabilize-vidstab, stabilize-deshake, dejudder, upscale, chain. Source S07 §8 test 2 expressly says every step; Failure lost/duplicated frames, altered frame rate/audio or codec/dimensions; Oracle ffprobe and copied-audio hash of artifact versus source; Interface runProc output file; Refactor every step implementation can change; Owner lowest common runner seam and duplicate processing.test metrics removed. Each case selects a distinct operation or chain.
- KEEP vid.stab quality with internal sidecar log removed. Source S07 §8 test 3; Failure insufficient stabilisation; Oracle before/after fixture artifact motion metric ≥60%; Interface runProc file; Refactor WASM internals can change; Owner stronger than removed direct-step duplicate.
- KEEP deshake quality. Source S07 §8 test 3/PST-004; Failure weak fallback stabilisation; Oracle artifact motion metric ≥40%; Interface runProc file; Refactor FFmpeg graph can change; Owner only fallback quality.
- REWRITE dejudder quality to output cadence metric and specified no-cadence note, removing internal sidecar field assertions. Source S07 §8 test 4/PST-010/012; Failure uneven cadence persists or steady input mislabeled; Oracle fixture/output motion CV and steady fixture; Interface runProc output/notes; Refactor cadence implementation can change; Owner strongest process owner; direct dejudder test owns byte-exact no-op.
- KEEP denoise sigma for each of atadenoise, fftdnoiz, nlmeans. Source S07 §8 test 5/PST-020; Failure no noise reduction; Oracle flat-patch metric from fixture/output; Interface runProc artifact; Refactor filter implementations can change; Owner sole quality owner for each caller-selectable method.
- KEEP deblock quality. Source S07 §8 test 5/PST-021; Failure block edges remain; Oracle fixture/output boundary-gradient metric; Interface runProc artifact; Refactor filter implementation can change; Owner sole quality owner.
- KEEP upscale seamlessness/mix. Source PST-033/S07 §8 test 6; Failure visible tile seam or non-linear mix; Oracle generated gradient and mathematical midpoint from input mix parameter; Interface exported ONNX upscale/FrameStep, lowest pixel-level seam; Refactor tiling internals can change; Owner sole seam/mix owner, process API owns dimensions/range.

### apps/engine/test/dejudder.test.ts

- DELETE 3-tap mean; 2-2-1 short-phase/ratio/consistency; absolute subrange phase; static-input internals; proxy threshold scaling; CV pure math; proxy dimensions; auto threshold success/failure reason matrix; 0.10 cell cut check; fine-texture cut check; worker URL resolution; synthetic decimated quality; force internal stats. These inspect private math/shape or duplicate processing-steps artifact quality. They fail the stable seam/refactor or stronger-owner requirements. Risk: no dedicated post-cleanup phase-in-subrange and scene-cut edge regression, because previous tests were private shape checks.
- REWRITE steady 30-fps pan case to exact decoded frame copy. Source PST-012/S07 §8 test 4 requires unchanged steady pan; Failure modified/dropped pixel or frame; Oracle a second decode of source bytes; Interface FrameStep output, lowest seam for exact no-op before lossy ProRes; Refactor cadence/flow internals can change; Owner runner proves note/quality but cannot prove pixel identity after lossy encode.

### apps/engine/test/vidstab-wasm.test.ts

- DELETE module resolution/version/SIMD/import inventory; override path; SIMD-vs-scalar equality; pure geometry/math cases (identity/translation/rotation, affine equivalence, detection/bands, source rows, cubic kernel); WASM-vs-test-only-TypeScript reference; native 8-bit test-only reference; worker-pool-vs-local equality; direct-step shaky motion quality. The runner artifact quality owner covers actual module loading/ABI and ≥60% stabilisation. These private comparisons or inventory checks fail stable seam/refactor; direct shaky quality duplicates the runner.
- REWRITE numeric warp into one independent integer-translation test. Source D-25 16-bit RGB warp geometry; Failure axis/sign flipped, channels swapped, truncation to 8 bit, row-band corruption; Oracle known full-depth RGB pattern and translated coordinates (values >255); Interface WarpPool.warp, lowest pixel-fidelity seam; Refactor C SIMD/worker code can change; Owner runner motion metric cannot detect channel/high-bit corruption. Failure modes were listed before keeping isolated test.

## Support/seams/validation

Removed TypeScript-only reference warp, cubicWeights, backwardAffine and barrel exports; removed VidstabWasm.setSimd/referenceTransform wrappers and TypeScript ABI declarations; removed dejudder cadence injection/decision getter and unused private math exports (no non-test caller); removed unused event capture fixture in processing-steps. Removed test-only vsx_ref_* and vsx_set_simd from scripts/vidstab-wasm/glue.c, rebuilt the pinned shipped vidstab.wasm and VIDSTAB-WASM.json with build.sh. The rebuilt module is 161,810 bytes (was 169,094), SHA-256 45c32b683e3afbda4a7ad77a0fe6a175293aa0788503f2af69897d7f59522871; its 24 WASM exports contain no removed test functions, and JSON SHA matches actual binary. No other production caller uses deleted seams (rg search).

Completed: focused dejudder + vidstab warp + processing CLI tests pass (3/3); processing-steps full suite passes (15/15); processing.test.ts + processing-remote.test.ts pass (15 pass, 1 real-SSH opt-in skip). After WASM rebuild, vidstab warp + full processing.test.ts pass (10/10), and emitted-media vid.stab quality passes (1/1, 14 unrelated tests filtered). Engine typecheck, Biome scoped check and git diff --check pass. Net reduction across scope about 859 text LOC plus 7,284 WASM bytes. Real SSH remains unrun without JASPER_TEST_SSH.

### Exact baseline title aliases for dynamic and shortened entries

The earlier MCP dispositions use abbreviated names for a few titles. These aliases assign the exact baseline title to the same disposition and rationale above.

| Path | Exact baseline title | Disposition / owner |
|---|---|---|
| `apps/engine/test/unit.test.ts` | `${name}: file agrees with the vector` | KEEP: each generated fingerprint vector is an independent fixed file/hash oracle; the existing unit ledger covers the six bars. |
| `apps/mcp/test/animation.test.ts` | `maps preset ids and converts seconds at the sequence rate (round, ≥ 1)` | DELETE: MCP resource readback at 50 fps owns observable duration. |
| `apps/mcp/test/animation.test.ts` | `loads the document only when a side gives seconds, at the clip sequence rate` | DELETE: private connection call count. |
| `apps/mcp/test/animation.test.ts` | `converts seconds at the rate of the sequence the transaction targets (selection, sequenceId, only one)` | DELETE: real MCP 50 fps project readback owns the rate requirement. |
| `apps/mcp/test/animation.test.ts` | `spreads frames evenly over [from, to) with both ends included` | DELETE: public `render_frames` output owns cell times. |
| `apps/mcp/test/animation.test.ts` | `round-trips through encodePng (opaque RGB with valid CRCs)` | DELETE: encoder/decoder self-consistency is no independent oracle. |
| `apps/mcp/test/integration.test.ts` | `lists, updates, applies and removes transitions (S10:TUI-060)` | REWRITE: retained public MCP transition workflow. |
| `apps/mcp/test/integration.test.ts` | `render_frame returns a downscaled PNG of the Program output` | REWRITE: retained requested-size PNG artifact in core MCP workflow. |
| `apps/mcp/test/integration.test.ts` | `cancel_job stops an export; wait_for_job then reports it as a tool error; existing files are kept` | DELETE: race tolerated success or cancellation; engine jobs and MCP cancelled-job mapping own distinct contracts. |
| `apps/mcp/test/integration.test.ts` | `lists text animations and animates text with add_text / set_text_animation (S11:ANA-002/008)` | REWRITE: retained saved-project frame duration and animation via MCP. |
| `apps/mcp/test/integration.test.ts` | `render_frames returns one PNG contact sheet of evenly spread frames (S11:ANA-004)` | REWRITE: retained PNG and specified cell times in real-engine MCP workflow. |
| `apps/mcp/test/color.test.ts` | `grade_clip grades in one "Agent: Grade clip" change and render_frame shows it` | REWRITE: retained grade/decoded pixel and event contract through MCP. |
| `apps/mcp/test/color.test.ts` | `keyframed params need a time: rejected without one, keyed at `at`` | KEEP: retained time validation and evaluated frame via MCP. |

## Export and encoder audit (owned by engine_processing)

Scope: `apps/engine/test/export.test.ts`, `apps/engine/test/encoders.test.ts`, owner modules `apps/engine/src/export/{native,planner,service}.ts` and `apps/engine/src/tools/encoders.ts`. Baseline: 20 export tests and 16 encoder tests; after cleanup, 18 export tests and 11 encoder tests remain. `DELETE` means the baseline test is gone; `REWRITE` names the retained narrower case, possibly split into independently observable cases; `KEEP` means its core case survived. The choices below were recorded before edits by reading the tests, their owners, S04 RN/RP/MS and D-13 (`docs/specs/04-media-render-and-backend.md`, `docs/wp-notes/wp-lgpl.md`), and WP-3I (`docs/wp-notes/WP-3I.md`).

Six-bar interpretation for each survivor: the cited requirement is the independent source (1); the failure column names a caller-visible bug that would fail it (2); the oracle column is fixture metadata, a protocol rule, or an independently authored expected media value, not calculated by the code under test (3); the seam column is a route/rendered artifact or the deterministic encoder-selection / FFmpeg protocol boundary (4); assertions on outcomes or necessary protocol bytes survive equivalent internal implementation changes (5); the owner column explains the lowest stable seam and absence of equivalent remaining coverage (6). D-13 selection cases use `selectVideoEncoder`/`encodingCapabilities` with synthetic inventories because route tests cannot safely emulate every FFmpeg installation; actual encoder viability is separately checked by a spawned probe. Render tests use API requests and probe/decode output artifacts, so a filtergraph refactor is free to change command text.

### apps/engine/test/export.test.ts baseline dispositions

| Baseline case | Disposition | Requirement, failure, independent oracle, seam, and distinct owner |
|---|---|---|
| plans native for a media-only sequence and returns a valid RenderPlan | KEEP | S04 RP-001/010/011: wrong path, segment class, or unstable plan ID breaks export planning. Known media-only document and public RenderPlan schema provide oracle; `/api/exports/plan` is public. Unique native planner contract; render success alone cannot prove deterministic plan/API fields. |
| bakes a text clip (hybrid); without Remotion it chooses remotion with a blocker; forcing native is refused | REWRITE → plans a text layer above footage for a hybrid export | S04 RP-003 and S11 LBK-002: wrong path would render title/footage incorrectly. Explicit text-over-video document and documented hybrid path are oracle; public plan route is seam. Deleted monkey-patched `layerBakeService.unavailableReason` and exact group ID/private blocker shape; layer-bake suite owns renderer-unavailable branch. |
| reports offline media, keyframed motion and motion graphics without fframes | REWRITE → warns when an export refers to offline media | S04 RP-008/010: missing `OFFLINE_MEDIA` warning hides a broken source from export callers. Intentionally unreachable locator is oracle; public plan route and warning code are stable. Warp tests own keyframed Motion; MG tests own fframes classification. Deleted synthetic `planned0` and direct `nativeBlockers` assertions. |
| exports a 2-track sequence to an mp4 whose frame count equals the range length | REWRITE | S04 RN-020/021/022, QA-005 and MS-002: wrong composition, codec/tags/audio, frame count, or Range response fails. Fixture colors, durations, requested settings, ffprobe and decoded pixels are independent; `/api/exports` plus GET artifact are public. Sole general native multilayer/audio/Range integration owner; removed redundant boundary-coordinate pixels. |
| places the scaled still exactly where the layer matrix says (filtergraph) | DELETE | Exact `scale`/`overlay` strings and clip-array positions were private graph shape. Remaining 2-track decoded export detects misplaced or hidden still; S04 RN-020 belongs there. No unique contract lost. |
| honors speed with setpts/atempo and seeks sources at the clip in-point | REWRITE → plays a trimmed clip at twice its source rate; time-stretches 4× audio while preserving its pitch; time-stretches 0.25× audio across the slow-speed range | S04 RN-020/021 and S01 CLP-008: wrong source in-point/rate, missing time stretch, or pitch shift changes exported frames/tone. Frame-code fixture and independent 1 kHz decay-reset tone supply oracle; decoded export is stable seam. These own native visual and audio speed, including the slow multi-stage tempo range. Original private graph-argument test removed. |
| renders a still frame natively for media-only frames (POST /api/stills) | KEEP | S04 still API: route failure, wrong output MIME/size, or undecodable PNG fails. Requested width and PNG probe are independent; HTTP/artifact seam. Dedicated still workflow, distinct from video export. |
| lists the export in the jobs API and 404s unknown render outputs | DELETE | Test depended on prior job state and its invalid render-path 404 could pass from route mismatch; jobs.test.ts owns jobs HTTP list/unknown-ID behavior, while this suite's failed-output denial owns real render access control. |
| starts every clip on its exact frame, also when the start is not a round number of seconds | REWRITE | S04 RN-022: rounding sources to decimal seconds can move a cut a frame. Burned frame codes independently specify expected timeline-to-source mapping; decoded MP4 is stable seam. Unique noninteger-second frame-boundary regression; removed `setpts` text checks. |
| cross-dissolves through the handles: frame i of d shows (i + 1) / (d + 1) of the incoming clip | REWRITE | S01 transition rule/S04 RN-020: incorrect handle/ramp produces visible jump or wrong blend. Source-coded bits and specified ramp fractions provide independent pixel oracle; rendered MP4 is seam. Unique cross-dissolve owner; deleted `tpad`, `trim`, `setpts`, and input-argument checks. |
| dips to black: the outgoing clip ends on a black frame, the incoming one fades in | REWRITE | S01 transition rule: failure produces wrong visible dip, timing, or outgoing code. Known colored fixture plus documented outgoing/incoming fade shape provide oracle; rendered MP4 is seam. Distinct transition type; deleted filter-string checks. |
| writes fades and audio fades as ffmpeg fade / afade with frame-exact starts | DELETE | Exact private helper arrays copied native.ts implementation and would fail equivalent renderer refactors. Rendered cross-dissolve/dip tests and audio-crossfade decoded export own user-visible ramps; layer-bake e2e also tests faded graphics. |
| exports a ProRes 422 HQ master (MOV, PCM audio) and honours an explicit H.264 bitrate | REWRITE → exports a ProRes 422 HQ master with PCM audio | S04 RN-024: wrong codec/profile/audio format makes master unusable. Requested ProRes settings and ffprobe codec/pixel format/audio/frame code are independent; public export/output seam. Unique ProRes end-to-end owner. Deleted graph-argument check for an H.264 request that this case never rendered. Explicit bitrate direct-args duplicate was also deleted; that setting's output-rate effect remains a residual risk. |
| detects the alpha of ProRes 4444 and of VP9 WebM, and decodes the WebM with libvpx | DELETE | Internal graph decoder/options, color filter string, and fixture probe self-check duplicated rendered alpha composite. That stronger output case would fail on dropped alpha, black box, or color shift. |
| decodes an alpha WebM that starts mid-file from its start (libvpx cannot always seek it) | REWRITE → preserves alpha when a trimmed VP8 overlay starts mid-file | S04 RN-031 and a known libvpx mid-file decode regression: alpha loss makes green/red sample wrong. Fixed half-alpha fixture over red underlay is independent; exported pixel is seam. Unique VP8 trimmed-input regression; removed private input-seek/trim command checks. |
| refuses the native path when the build has no libvpx decoder for an alpha WebM | KEEP | S04 RN-031 and D-13 capability rule: selecting native without needed decoder yields broken transparent output. Synthetic decoder inventories and alpha source establish oracle; planner result is lowest deterministic capability seam. Distinct from successful-alpha export since real FFmpeg cannot simulate absent decoder. |
| composites both overlays with their alpha (no black box, straight alpha, no colour shift) | KEEP | S04 RN-031: either ProRes 4444 or VP9 alpha can render opaque, premultiplied, or shifted; decoded red/green/white sample values from authored fixture expose it. Public export/output seam; sole dual-format final composite owner. |
| copies to an absolute destination path without overwriting and rejects relative paths | KEEP | S04 export destination safety and HTTP validation: relative path accepted or existing file overwritten is visible/data-loss bug. Existing sentinel bytes and requested custom range provide independent oracle; HTTP route and disk artifact seam. Unique destination safety owner. |
| removes the stored request of an export that failed for good; sweeps stale requests (WP-3I) | KEEP | WP-3I explicitly specifies nonretryable cleanup and seven-day sweep. Seeded request files/mtime provide independent oracle; persisted request store and queue are the lowest storage seam. Failure leaks disk state across restarts; not covered by successful export. |
| never serves the output of a render that has not succeeded | KEEP | S04 output authorization: serving a partial/failed artifact leaks invalid bytes. Deliberately failed job with planted file is independent; GET `/renders/:id/output` is public seam. Unique failed-output access rule; other 404 checks did not establish a file existed. |

### apps/engine/test/encoders.test.ts baseline dispositions

| Baseline case | Disposition | Requirement, failure, independent oracle, seam, and distinct owner |
|---|---|---|
| LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message | REWRITE | D-13: an LGPL host without H.264 must still export and proxy with specified fallbacks. Synthetic installed/usable inventory is independent; selector output is the deterministic capability seam. Unique fallback order; removed exact message copy. |
| VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC | KEEP | D-13 container/audio rule: incompatible muxing or silent output would fail. Two inventories differ only in Opus availability; selector output is protocol choice seam. Unique VP9 container distinction. |
| OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF) | REWRITE | D-13: OpenH264 lacks CRF; wrong rate-control args make export fail. OpenH264-only inventory and FFmpeg's encoder protocol are independent; selector and generated args are lowest hardware-independent seam. Removed copied bitrate arithmetic and ancillary flag inventory; retains needed rate-control bytes. |
| hardware-only: the first usable encoder in preference order wins (test encodes decide) | REWRITE | D-13: listed but unusable hardware must not be selected; priority is VideoToolbox/NVENC/QSV/AMF/VAAPI. Synthetic usability inventory is independent; selector result is seam. Distinct hardware-only failure; removed exact UI label copy. |
| full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL | REWRITE | D-13 licensing/priority: a GPL encoder selected in LGPL-only mode violates distribution rule. Two explicit inventories and documented preference establish oracle; selector output is seam. Unique license-mode branch; removed exact explanatory copy. |
| honours an explicit encoder only when it is usable | REWRITE | D-13 explicit selection: user-selected unusable/GPL codec must fall back and report effective choice. Synthetic inventories and request are independent; selector output is seam. Unique explicit-request branch; removed exact message copy. |
| nothing usable → null and a capability message | REWRITE | D-13: no encoder must be exposed as unavailable rather than a job that fails later. Empty video inventory gives oracle; capabilities schema/output is caller-facing seam. Unique no-video failure; removed exact message wording. |
| capabilities report codecs, audio and ProRes (schema-valid) | KEEP | D-13 `GET /api/capabilities` media encoding contract: wrong inventory prevents UI/agent codec choices. Synthetic LGPL/GPL inventory and API schema define oracle; `encodingCapabilities` is lowest deterministic matrix seam. Unique capability projection (selection tests do not check full schema). |
| libx264 keeps the historical preset/CRF mapping and GOP params for proxies | DELETE | Exact private FFmpeg argument snapshot, with no independent required byte sequence; equivalent encoder settings would fail it. Native export artifact and media proxy tests own user-visible encode behavior. |
| maps CRF to VP9/AV1 scales | DELETE | Copied private math constants and generated flag strings; quality scale algorithm is not public contract. LGPL binary and export/proxy integration own viable output; removed unused `av1Crf` export. |
| hardware encoders: pixel formats, device setup and quality knobs | DELETE | Cross-platform private command inventory with exact flags, no actual hardware execution; a valid alternative setup would fail it. Probe test retains device usability selection; actual hardware behavior is unverified on this host and remains risk. |
| selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec | KEEP | D-13/S04 RN-024: silent substitution or wrong mux/audio format would violate explicit ProRes request. Inventory including then excluding `prores_ks` gives independent oracle; selector is lowest capability seam. Export artifact separately owns actual master encoding. |
| writes ProRes 422 HQ (10-bit 4:2:2) or 4444 (4:4:4) | DELETE | Exact private FFmpeg args duplicated ProRes export artifact for 422 HQ; alpha export tests cover 4444 decode/composite, layer-bake output tests cover 4444 generation. |
| uses an explicit bitrate as the OpenH264 target and as the x264 VBV ceiling | DELETE | Exact FFmpeg arg array copied implementation; no rendered bitrate artifact in baseline. Removed under strict bar; bitrate-setting behavior is a residual coverage risk, not a reason to retain private shape. |
| parses the build license and hwaccels | REWRITE | D-13 license detection must distinguish LGPL, GPL, nonfree, unknown; FFmpeg `configuration:` and `-hwaccels` output are external protocol. Wrong classification can select forbidden encoder or hide capability. Parser is lowest stable byte seam; removed vendor error-message extraction copy. |
| test-encodes listed hardware encoders with a fake ffmpeg and caches per binary | REWRITE | D-13 requires an actual test encode before using a hardware wrapper. Fake executable returning success only for NVENC is independent executable protocol; probing/EncoderService result is lowest deterministic seam and catches selected broken hardware. Removed exact stderr copy and private VAAPI command assertion; log-call count still checks binary probe cache but may be pruned if deemed internal. |

### Support and validation

No fixture media or snapshots became unused: `frame-code.mp4`, `tone.wav`, alpha MOV/WebM/VP8, clip A/B and still remain referenced by retained artifact cases. Removed the private `planned0` synthetic clip fixture and unused test imports. In `apps/engine/src/tools/encoders.ts`, removed test-only exports from `bitrateForCrf`, `av1Crf`, `hwTestArgs`, and `hwFailureReason`; `rg` found no non-test callers outside this module. The functions themselves remain used by production encoder selection/probing. `vp9Crf` stays exported because Remotion export-plan imports it.

Risk: FFmpeg/hardware availability differs by OS, so synthetic inventories test decision rules without claiming real hardware verification. Pixel/audio tolerances account for lossy codec output. ProRes, alpha, frame timing, destination, and fades remain artifact-tested. Exact bitrate behavior lacks a stable output test after the private arg snapshot deletion; the corresponding setting should be verified in a future bitrate-sensitive fixture if it regresses. Validation: focused `pnpm --filter @jasper/engine exec vitest run test/encoders.test.ts test/export.test.ts` passed 27/27 before adding two rendered audio speed cases; 4×/0.25× rendered audio focused rerun passed 2/2 (16 skipped), covering duration, decay timing, and preserved 1 kHz pitch. `pnpm --filter @jasper/engine typecheck` passed after concurrent processing edit settled. Biome and diff checks passed after final formatting.

### Exact baseline title crosswalk for grouped processing and warp audits

The grouped audit entries above provide the six-bar rationale for each retained case. This crosswalk assigns every abbreviated baseline title an explicit disposition and links it to that rationale or to the stronger owner for a deletion.

| Baseline path | Exact baseline title | Disposition and reason |
|---|---|---|
| `apps/engine/test/dejudder.test.ts` | `3-tap moving mean with zero padding (np.convolve same)` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `finds the short phase, ratio and consistency of a 2-2-1 pattern` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `reports the phase in absolute frame indices when a sub-range is analysed` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `static input: no phase, NaN ratio and consistency` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `scales the moving threshold with the proxy width` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `evenness: CV of the relative steps and phase min/max` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `analysis proxy ≤ 424 px wide with even sizes` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `applies a clear, moving cadence` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `rejects each failed threshold with a reason` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `trips above a mean absolute difference of 0.10` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `a fast pan over fine texture is not a cut; a different picture is` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `honours the env override and resolves the source worker by default` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `detects the 2-2-1 cadence and evens it out, frame count preserved` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/dejudder.test.ts` | `leaves a steady 30 fps pan untouched in auto mode` | **REWRITE**: PST-012 exact no-op: source decode is independent oracle, FrameStep output is stable seam; uniquely catches changed frames before lossy encoding. Six bars in dejudder section. |
| `apps/engine/test/dejudder.test.ts` | `force mode retimes the steady pan too, and copies frames whose neighbour is missing` | **DELETE**: Private cadence math/worker shape or duplicate quality result; processing-steps artifact cadence owner. |
| `apps/engine/test/processing-remote.test.ts` | `builds argument arrays with the PRM-002 options` | **DELETE**: Private SSH argv shape; remote API/SSH scenarios above own observable behavior. |
| `apps/engine/test/processing-remote.test.ts` | `probe before setup: connected, runtime not installed, no GPU` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `setup uploads the runtime; probe then reports it ready (CPU ONNX, no CUDA)` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `auto executor runs remotely; the input is cached by fingerprint; the job dir is removed` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `an interrupted upload resumes (rsync --partial --inplace)` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `cancel kills the remote process group and leaves no job directory` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-remote.test.ts` | `probe, setup, process, cleanup` | **KEEP**: Remote API, SSH state, filesystem, and process outcome; six-bar owner in the processing-remote section. |
| `apps/engine/test/processing-steps.test.ts` | `none of the GPL-only filters exists in the LGPL build; generated text is guarded` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `vid.stab (WASM): motion variance drops ≥ 60 %` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `deshake: motion variance drops ≥ 40 %` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `judder.mp4 is detected and evened out; steady-pan.mp4 is left unchanged` | **REWRITE**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `noise sigma of a flat patch drops ≥ 40 % (medium) with every method` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `deblock reduces 8x8 blockiness ≥ 25 %` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing-steps.test.ts` | `tiles are seamless on a gradient and mix blends linearly` | **KEEP**: S07 media artifact quality or D-13 FFmpeg filter rule; independent fixture and output oracle, stable runProc/FFmpeg seam, distinct operation owner in the processing-steps section. |
| `apps/engine/test/processing.test.ts` | `lists the model catalogue with install state` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `stores settings in engine.json and validates them` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `probe/setup without settings answer a clear "not configured" error` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `reports features.processing and licences (vid.stab, ONNX Runtime, OpenCV.js, weights)` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `the vid.stab pin mirrors scripts/ffmpeg/manifest.json` | **DELETE**: Build manifest consistency change detector; build/check scripts own shipped pin. |
| `apps/engine/test/processing.test.ts` | `rejects unknown media and uninstalled models` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `denoise + deblock: same frame count and rate, ProRes BT.709, audio copied bit-exact, registered, reused` | **REWRITE**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `upscale with the generated test model: exactly 2× (range processing)` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `cancel kills jasper-proc and leaves no partial output` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/processing.test.ts` | `a sequence using a processed version plans native and exports reading the ProRes file (S07 §8 test 8)` | **KEEP**: Public processing route, job, storage or rendered output contract; independent request/fixture oracle and distinct six-bar owner in the processing section. |
| `apps/engine/test/tracking-unit.test.ts` | `maps media px ↔ tracking px with pixel centres at integers` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `detects convex quads and builds feature masks (inside with inset, ring outside)` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `fits off = a + b·t through 30 % outliers` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `planar confidence = inlier ratio × (1 − error/threshold)` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `snaps a 1–2 px-off predicted quad to the luminance steps within 0.15 px` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `finds the dark valley of a bezel mask between two bright areas` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `snaps to the edge nearest to the given side, never across the bezel (wall → bezel → mask → screen)` | **REWRITE**: TRK-012 authored image/quad oracle at image-to-quad seam; uniquely catches competing-bezel or clipped-side failure. Six bars in warp/tracking survivor table. |
| `apps/engine/test/tracking-unit.test.ts` | `keeps the predicted line for sides outside the frame and rejects far edges` | **REWRITE**: TRK-012 authored image/quad oracle at image-to-quad seam; uniquely catches competing-bezel or clipped-side failure. Six bars in warp/tracking survivor table. |
| `apps/engine/test/tracking-unit.test.ts` | `spans: forward = ref…end, backward = start…ref, both = range` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `validates the reference frame, range and geometry` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `builds worker configurations in tracking px` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `decodes with an input seek half a frame early, LGPL filters only` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking-unit.test.ts` | `loads OpenCV, tracks a translated texture and reports errors without dying` | **DELETE**: Private geometry/worker shape or duplicate accuracy; HTTP ground-truth tracking and retained bezel tests own outcomes. |
| `apps/engine/test/tracking.test.ts` | `answers 404 ASSET_NOT_FOUND for an unknown media key` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `answers 400 VALIDATION_FAILED for bad bodies and geometry` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `reports features.tracking in the capabilities` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `lands on the exact frames after an input seek (system ffmpeg)` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `tracks the plate both ways from a mid reference within 1.5 px RMS, 4 px max, with live progress` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `tracks forward only (span = reference … end) and pads frames past the end of the media as lost` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `tracks backward with the surroundings ring (span = start … reference)` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `TRK-014: balanced 1080p planar speed (reported; fails below 12.5 frames/s on an idle host)` | **DELETE**: Load-dependent speed probe had a weaker threshold than specification and could skip; no reliable gate, benchmark risk recorded. |
| `apps/engine/test/tracking.test.ts` | `tracks the blob both ways within 1 px RMS` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/tracking.test.ts` | `stops a running track job within 500 ms` | **KEEP**: S09 public HTTP job/capability or decoded-frame contract with authored fixture oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/vidstab-wasm.test.ts` | `resolves, compiles and reports version + SIMD` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `honours JASPER_VIDSTAB_WASM and falls back when the override is missing` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `SIMD and scalar motion detection give identical local motions` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `identity, translation and rotation about the frame centre` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `the affine matrix is the same map` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `scales detection transforms, sizes detection frames, splits bands` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `source rows of a band cover every bicubic tap` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `vid.stab's bicubic kernel: partition of unity, interpolating` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `WASM SIMD warp equals the TypeScript reference (±1 code value)` | **REWRITE**: D-25 full-depth RGB integer translation: independent pixel oracle at WarpPool output; uniquely catches high-bit/channel/band corruption. Six bars in vidstab section. |
| `apps/engine/test/vidstab-wasm.test.ts` | `matches vid.stab's own 8-bit transform (same geometry and kernel)` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `the worker pool gives the same result as the calling thread` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/vidstab-wasm.test.ts` | `reduces the inter-frame motion variance by ≥ 60 % and keeps the frame count` | **DELETE**: Private WASM/reference comparison or duplicate stabilization; processing-steps emitted-media quality and retained WarpPool pixel test own behavior. |
| `apps/engine/test/warp-unit.test.ts` | `is exactly the head of every layer chain of the builder (solid with crop/flip, still with Motion)` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `uses a `layer` override as the source; a `sequence` override of any extension wins in the builder` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `the identity reproduces the source exactly and leaves the rest transparent` | **REWRITE**: TRK-032 independent numeric pixel/BT.709 oracle at worker buffer seam; distinct sampling/alpha failure. Six bars in warp/tracking survivor table. |
| `apps/engine/test/warp-unit.test.ts` | `a half-pixel shift averages neighbours; edges fade to transparent without darkening (premultiplied)` | **REWRITE**: TRK-032 independent numeric pixel/BT.709 oracle at worker buffer seam; distinct sampling/alpha failure. Six bars in warp/tracking survivor table. |
| `apps/engine/test/warp-unit.test.ts` | `multiplies alpha by the opacity; only the rectangle is computed; yuva output is BT.709 TV range` | **REWRITE**: TRK-032 independent numeric pixel/BT.709 oracle at worker buffer seam; distinct sampling/alpha failure. Six bars in warp/tracking survivor table. |
| `apps/engine/test/warp-unit.test.ts` | `destRect bounds the projected box with a 1 px fringe, clamped` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `claims corner-pinned / keyframed-Motion / animated-opacity layers of sourceable kinds only` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `reports effects nobody renders; accepts other extensions’ effects; composition needs an MG extension` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `per-frame maps follow the keyframes; source px are scaled to the (unrounded) intrinsic box` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp-unit.test.ts` | `decodes raw RGBA frames and encodes ProRes 4444 with alpha; no GPL-only filter anywhere` | **DELETE**: Private builder/filter/matrix structure; planner and decoded native export artifacts own caller-visible contract. |
| `apps/engine/test/warp.test.ts` | `plans native for corner-pinned still / solid / video overlays and keyframed Motion + opacity` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `still blocks what the warp stage cannot render; unclaimed kinds keep their M1 blockers` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `exports a corner-pinned still over a video plate natively; the second export reuses the cache` | **REWRITE**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `the generated filter text (builder + warp decode) uses no GPL-only filter (D-13)` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `a corner-pinned card: corners ≤ 1 px from the resolved quad, colour ≤ 3/255 off the edges` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `keyframed Motion + opacity mid-animation: corners ≤ 1 px, colour ≤ 3/255` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `warps a full-frame 1080p layer with keyframed Motion at ≥ 12.5 frames/s (target 25)` | **DELETE**: Load-dependent throughput probe used sub-spec threshold; no reliable gate, benchmark risk recorded. |
| `apps/engine/test/warp.test.ts` | `warps a composition clip from an earlier extension’s `layer` override; fails clearly without one` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
| `apps/engine/test/warp.test.ts` | `cancels mid-render: children stopped, no partial or cached file left` | **KEEP**: S09 native plan/export/still artifact or cancellation contract with fixture/format oracle; distinct six-bar owner in warp/tracking survivor table. |
