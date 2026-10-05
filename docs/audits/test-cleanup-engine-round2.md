# Engine core and incoming cache/MG test cleanup — round 2

Pre-edit record, made after merging remote `87ebec9`. This is a fresh reading of current tests, owners and cited requirements, not acceptance of the previous audit. Rendering, processing and media partitions have separate round-2 records.

For each KEEP/REWRITE below the numbered evidence is: **1** the independent requirement in its file section; **2–3** the literal behavior named by the test (fixed input bytes, specified status/code/time, authored media or external renderer output) is the failure and oracle; **4** the section’s stable seam; **5** assertions observe outputs, so identifier/collaborator refactors preserve them; **6** each row owns its distinct named boundary and stronger coverage is stated below. REWRITE removes the listed non-contract assertions before survival. No private implementation shape is accepted as its own requirement.

Risk: retained rows protect the named caller-visible failure; deletions have low risk for the stated stronger owner, with no numerical deletion target. Validation for each section: `pnpm exec vitest run apps/engine/test/<file>.test.ts`; additionally engine typecheck and repository gates. MG_E2E=1 exercises the six opt-in actual-render cases; their media outputs are retained as artifacts in temporary appdirs.

## `apps/engine/test/unit.test.ts`

Independent sources (bar 1): S01 AST-003; S04 MS-003/ENG-023/WF-001/PB-001–004/ENG-022; WP-3I. Stable seam (bar 4): Fingerprint file/API, signer, bounded event replay, PCM stream reducer, ffprobe protocol mapper, HTTP error adapter, engine config. Non-test callers: Media registration/derivative services, HTTP security/events routes, engine startup. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — empty: file agrees with the vector | Wrong empty-file fingerprint; fixed SHA-256 vector from independent Python calculation under S01:AST-003, through `fingerprintFile`; catches a boundary not covered by a media fixture. |
| **KEEP** — abc: file agrees with the vector | Wrong small-file fingerprint; independent fixed digest, through `fingerprintFile`; unique nonempty short input. |
| **KEEP** — 8 MiB (whole file): file agrees with the vector | Incorrect first/last-window handling at the threshold; independent fixed digest, through `fingerprintFile`; unique threshold case. |
| **KEEP** — 9 MiB (first+last 4 MiB): file agrees with the vector | Wrong two-window fingerprint; independent fixed digest, through `fingerprintFile`; unique over-threshold case. |
| **KEEP** — media keys are mk_ + 24 hex of the fingerprint | Invalid or unstable media identity; S01:AST-003 literal prefix/length and invalid input, through `mediaKeyFor`; no other owner checks exact key derivation. |
| **KEEP** — verifies path + expiry and rejects tampering | Forged/expired signed media access; S04:MS-003 path and expiry rules provide literal true/false oracle through `UrlSigner`; the HTTP signed-media test cannot advance expiry and this is the lowest deterministic seam. |
| **REWRITE** — assigns monotonic ids, replays since an id and filters by project | Retain only bounded-buffer complete/incomplete replay. NDJSON socket test already owns filtering, monotonic IDs, heartbeat and resume. |
| **KEEP** — computes max-abs per channel and per window across chunk boundaries | Incorrect audible waveform channels or chunk-boundary peaks; S04:WF-001 gives max-absolute/100-peaks-per-second semantics and hand-chosen PCM values, through the production peak reducer; derivative HTTP test checks file format, not numeric per-channel values. |
| **KEEP** — reads legacy rotation tags when the display matrix is absent | A legacy rotate tag must yield upright display dimensions under S04:PB-003. Fixed FFprobe-shaped metadata is supplied to production `probeFile`, with expected 270°/1080×1920 independent of the mapper; `media.test.ts` covers real display-matrix rotation, so this retains only the missing legacy case. |
| **KEEP** — detects VFR and VP9 alpha metadata | Wrong VFR badge or lost WebM alpha; S04:PB-002 and PX-001 define the numeric rate threshold and alpha outcome. Fixed FFprobe metadata enters `probeFile`; real media tests already own PNG/audio/ProRes classification, so those duplicate fixture cases were removed. |
| **KEEP** — maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths | Wrong public error code or leaked local paths; S04:ENG-022/SC error and secrecy requirements define statuses/codes/absence of paths through a Fastify guarded reply. No other test drives all three OS-error branches. |
| **KEEP** — the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173) | A second dev stack cannot reach the engine, or a production host is trusted; WP-3I environment option and fixed ports define the expected host set via engine config. `server.test.ts` checks normal host rejection, not the custom environment mapping. |
| **KEEP** — resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root) | Relative packaged web assets fail to serve; WP-3I env path rule supplies expected absolute path through engine config. SPA route tests use an already absolute directory. |

## `apps/engine/test/server.test.ts`

Independent sources (bar 1): S04 ENG-020/022, SC-001; ARCHITECTURE 4.2/4.3/9.1; WP-MCP runtime discovery. Stable seam (bar 4): HTTP status/body/headers or startup disk artifacts. Non-test callers: CLI and desktop engine startup. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — GET /health returns ok with the API header | Health client cannot identify API version; documented health body/header, unlike other route smoke tests. |
| **KEEP** — rejects foreign Host headers (DNS-rebinding defense) | Browser reaches local service via attacker Host; fixed 403/allowed loopback status, unique host defense. |
| **KEEP** — local token mode requires the bearer token or session cookie, except /health | Protected data exposed or legitimate local session locked out; fixed 401/200 token-cookie statuses, unique general auth policy. |
| **KEEP** — serves the SPA with a fallback that never shadows engine paths | Deep links fail or engine URLs return HTML; fixed HTTP content/status and reserved paths, unique navigation fallback. |
| **REWRITE** — uses the ENG-022 error shape for bad requests and unknown routes | Drop exact human message; keep required error code/status/retryability and malformed JSON response. |
| **KEEP** — rejects cross-origin requests (same-origin only, S04:SC-001) | Cross-site page can mutate engine state; fixed forbidden/allowed Origin status, unique CSRF defense. |
| **KEEP** — refuses a non-loopback bind without a token (M1 is loopback only) | Unauthenticated network exposure; specified startup refusal, unique bind policy. |
| **KEEP** — writes <appdir>/engine/runtime.json (0600) for local tools and removes it on stop | Local tools cannot connect or token file leaks; specified path, contents, permissions, and deletion are independent, unique startup lifecycle. |
| **KEEP** — wipes tmp/ but keeps .gitkeep | Stale temporary job files survive restart; ARCHITECTURE §4.3 defines wipe and `.gitkeep` retention, observed on disk. Removed the exact root-directory inventory, which merely tracked current implementation. |

## `apps/engine/test/events.test.ts`

Independent sources (bar 1): S04 ENG-023/RT-002/004; WP-2F fonts; D-13 license reporting. Stable seam (bar 4): Actual NDJSON socket and public capabilities/fonts HTTP. Non-test callers: Browser clients and capability providers. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — streams live events after an initial heartbeat, filtered by projectId, and resumes with ?since= | Lost, reordered, or cross-project events; fixed published event sequence and monotonic IDs over real socket. |
| **KEEP** — rejects a malformed since | Invalid resume cursor accepted; documented 400 `VALIDATION_FAILED` over HTTP. |
| **REWRITE** — reports ffmpeg, native render, Remotion state and provider patches (WP-2G hook) | Drop hardcoded engine version and positional license inventory; retain actual capabilities, provider changes and license data by component ID. |
| **KEEP** — serves the curated font catalog and immutable font files | Font picker receives unusable Inter font or wrong fallback/unsafe path; WP-2F requires bundled WOFF2 service and Source Sans 3 fallback. Assert catalog-discovered URL returns WOFF2, immutable cache, fallback and path rejection. Removed the exact ten-family list, list position, internal filename and nearest-weight shape checks. |

## `apps/engine/test/jobs.test.ts`

Independent sources (bar 1): S04 JB-011/012/013/014/020/030/040; QA-007/008; ENG-004. Stable seam (bar 4): JobQueue scheduling/persistence and actual process cancellation; HTTP cancellation route. Non-test callers: All derivative/export/processing runners and jobs routes. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — runs lanes in priority order within the CPU slots and dedupes by key | Interactive work starves or duplicate work runs; specified priority order/slot bound/key identity. |
| **KEEP** — starts exports with at least half the slots and pauses the background lane meanwhile (JB-012/013) | Export stalls behind background work; specified minimum slot reservation and pause. |
| **KEEP** — fails with a retryable error, keeps a log, and retries as a new job | Caller cannot recover a transient job or sees false retryability; specified code/log/new ID and result. |
| **KEEP** — throttles job.updated to 4/s per job and always sends the final state (JB-040) | Event flood or missing completion; fixed 4/s upper bound and terminal event. |
| **KEEP** — cancels a running ffmpeg job within 5 s with no child process left and removes partials | Cancel leaves CPU process/output behind; real FFmpeg, 5 s requirement, no PIDs/partial file. |
| **KEEP** — cancels queued jobs immediately and cascades to child jobs | Queued descendants run after parent cancellation; specified cancelled states. |
| **KEEP** — cancels over HTTP (POST /api/jobs/:id/cancel) | API client cannot cancel/retry or sees cancelled job active; documented route statuses and job state. |
| **KEEP** — marks a running job interrupted after a crash, restores queued jobs and re-queues artifact jobs | Restart loses jobs or retries export automatically; specified recovered states and exactly-once artifact work. |
| **KEEP** — graceful shutdown records running jobs as interrupted (S04:ENG-004) | Shutdown leaves phantom running jobs; specified interrupted state persisted across restart. |

## `apps/engine/test/mcp.test.ts`

Independent sources (bar 1): WP-MCP; MCP Streamable HTTP session/auth protocol. Stable seam (bar 4): Real MCP SDK plus raw HTTP status codes. Non-test callers: External MCP clients. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — serves the jasper-mcp tools to an SDK client with the engine token | MCP client cannot list/call tools or persist project change; real SDK session plus saved marker in project document. |
| **KEEP** — requires the token and a known session | Anonymous or uninitialized caller reaches tools; protocol's 401/404/400 statuses for token/session/initialize. |

## `apps/engine/test/uploads.test.ts`

Independent sources (bar 1): S04 IN-005/011 and SC-005. Stable seam (bar 4): HTTP chunk upload and disk-backed UploadService lifecycle. Non-test callers: Upload HTTP routes and media import services. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — uploads clip-b in 3 chunks, rejects a wrong offset with the expected one, and registers the media | Chunk replay/out-of-order write corrupts media; declared byte offsets, 409 expected offset, full stored/served bytes and registered metadata. Removed fingerprint comparison to the same production helper and queue-kind inventory; public media derivative states now prove scheduling. |
| **KEEP** — aborts an upload session | Cancelled upload remains resumable; first DELETE succeeds and repeated DELETE is 404. Removed a traversal URL that only exercised route matching, and changed the filename to an ordinary upload name. |
| **KEEP** — checks free disk space (DISK_FULL) and expires idle sessions after 24 h (S04:SC-005) | Oversized upload allocates data or stale session remains; actual filesystem free-space probe rejects `Number.MAX_SAFE_INTEGER` with exact `DISK_FULL` before any session file, normal small upload succeeds, and a fake system Date advances 25 h for expiry. This replaces service-only `freeBytes`/`now` injection hooks, which had zero production callers. |

## `apps/engine/test/agent.test.ts`

Independent sources (bar 1): S01 AGT-002/004/010/011/020; ARCHITECTURE 11; WP-MCP. Stable seam (bar 4): HTTP API, WebSocket protocol, AgentService timeouts. Non-test callers: Agent HTTP/WS routes; desktop and MCP tools. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — describes commands, queries, addressing, approvals and error codes | Agent cannot discover schemas/error codes; specified schema categories and approval command through GET schema. |
| **KEEP** — publishes editor.openProject globally and reports listening editors; 404 for unknown projects | Connected editor does not open requested project or unknown project appears valid; specified event/status/path. |
| **KEEP** — reports the HTTP endpoint and the stdio bundle path, never the token | Help screen leaks the engine token; token-configured engine request and response serialization must exclude the actual token while matching public MCP-info schema. Former no-token setup could pass for the wrong reason. |
| **KEEP** — finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides | Agent launch cannot locate MCP bundle in installed/checkout layouts; documented paths and explicit override via launcher entry resolution. |
| **KEEP** — applies, saves a new revision and publishes doc.changed | Headless agent appears successful without durable edit; specified revision, saved marker and global change event. |
| **KEEP** — rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404 | Headless agent deletes without approval or works on missing project; specified error code/status and session-only query rejection. |
| **KEEP** — rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11) | Agent overwrites concurrent edit or rejects safe disjoint change; fixed revision/error and successful fast-forward. |
| **KEEP** — relays transactions and queries to the session that holds the lease and forwards its events | Live editor commands/query/events are lost or applied headlessly; fixed WS request-response envelopes and forwarded event. |
| **KEEP** — asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED | Destructive edit proceeds on deny or approved edit never reaches editor; specified decision/error/protocol flag. |
| **KEEP** — falls back to headless when the session disconnects before a request | Agent request hangs after editor disconnect; successful persisted headless result. |
| **KEEP** — returns E_APPROVAL_TIMEOUT when nobody answers the approval | Destructive request hangs or auto-approves; specified timeout code and cleared pending state at the service timeout seam. |
| **KEEP** — ignores approval answers from connections that never said hello | Unauthenticated socket approves deletion; timeout remains the independent security oracle. |
| **KEEP** — returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired | Ghost lease causes silent headless write or never recovers; specified live error then expired lease success. |
| **KEEP** — rejects oversized transactions (limits) | Oversized transaction bypasses specified `E_LIMIT`; 5,001 commands and fixed code via `AgentService`. Duplicate relay portion was already owned by the WS relay case. |

## `apps/engine/test/projects.test.ts`

Independent sources (bar 1): S01 PER-002/016/019/020/025/040; ARCHITECTURE 9.2. Stable seam (bar 4): HTTP project/lease API, ProjectStoreFs disk versioning and public session store adapter. Non-test callers: Editor EngineProjectStore, MCP/agent persistence and engine project routes. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **KEEP** — creates, lists and opens a project envelope | Created project missing, wrong preset or traversal accepted; expected project envelope/schema and 400/404 outcomes. |
| **KEEP** — saves with If-Match revisions and answers 409 with the current revision on conflict | Concurrent writer silently overwrites state; expected 409/current revision and persisted winner. |
| **KEEP** — works end to end with the session EngineProjectStore (open → save → conflict) | Session adapter cannot speak engine protocol; open/save/conflict/view/version/lease/delete via real client/store pair. |
| **KEEP** — keeps versions at most every 5 minutes of saving (S01:PER-020) and stores the view file | Undo safety copies missing or excessive; fixed clock with version revisions at 0/2 and durable view. |
| **KEEP** — grants one holder, refreshes by heartbeat, expires after 30 s and releases | Two editors write concurrently or expired holder blocks work; specified 409/heartbeat/30 s/release. |
| **KEEP** — takeOver revokes the other holder (WP-2E "Take over editing") | User takeover leaves old editor writable; new lease and old heartbeat 404. |

## `apps/engine/test/cache.test.ts`

Independent sources (bar 1): S04 CA-003/004/010–020; S06 CG-056; WP-M3-inpoint PRC-018. Stable seam (bar 4): Cache HTTP, disk artifacts, CacheService pin/acquire/ref protocol and JobQueue retention. Non-test callers: Export/color/warp/layer-bake/media/MG producers and cache routes. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **DELETE** — maps every cache path to its entry and nothing else | Private entry-ID/path mapping repeats layout implementation; usage and cleaning tests exercise every seeded artifact kind through HTTP and surviving files. No distinct storage compatibility contract specifies internal entry IDs. |
| **DELETE** — scans entries of every kind and the temporary files of interrupted writes | Private scan-object inventory duplicates usage counts, Clean Unused artifact removal and orphan crash recovery; same fixtures and broader behavioral owner remain. |
| **DELETE** — media fingerprints, bundle hashes and the preview + master render keys of composition clips | Expected reference set calls the production snapshot/master-request/key helpers used by the owner, so bar 3 fails. Retained saved-media, MG cleanup, persisted export-ref and export/GC tests own observable preservation. |
| **REWRITE** — reports usage per kind: in use, referenced by saved projects, unused (CA-013) | Drop total derived from response fields and kind-count inventory; keep fixture-derived bytes/reference splits, documented limits and current-bundle protection. |
| **KEEP** — "Clean Unused" keeps referenced, pinned and recent entries and sweeps stale temporary files (CA-014, CA-017) | CA-014/017: accidental deletion would break active exports or saved project previews; authored old/recent files and explicit pin/reference setup independently require preserved referenced/pinned/recent bytes, deletion of unused artifacts, and a one-hour orphan boundary. HTTP cleaning is the lowest full policy seam; layout-unit tests were deleted. |
| **KEEP** — "Clean All (not in use)" removes what saved projects reference but keeps open projects and running jobs (CA-014) | CA-014 distinguishes saved-only from open project references. Disk presence must change after acquiring/releasing a real lease or production open-project adapter. Other GC cases exercise unused mode, not this override of saved references. |
| **KEEP** — an open project keeps what its editor shows before the autosave (live document; integration regression) | CA-012/014: deleting derivatives imported into an unsaved open document visibly breaks preview. Saved fixture deliberately lacks media while the live-document adapter contains it; GC must retain only live media until that source is disconnected. This unique pre-autosave failure is not covered by saved-project protection. |
| **KEEP** — automatic passes: per-kind age limits, then LRU eviction under kind and total budgets; referenced entries stay (CA-003, CA-015) | CA-003/015 independently specify 7-day exports, 1-day stills, global/custom limits, oldest-unused-first eviction and retention of references even over budget. Authored timestamps/bytes force each result through HTTP clean/settings; manual all/unused cases cannot catch automatic budget-order mistakes. |
| **KEEP** — validates and persists the settings (engine/cache.json) | CA-015/ENG-012 specify persistent cache settings and immediate effect. Negative limit/unknown kind must return 400; literal custom limits survive GET and disk serialization and appear in usage. No GC test alone detects loss of settings serialization. |
| **KEEP** — a lookup racing a removal either keeps the entry or misses; never a path that disappears (CA-016) | CA-016 requires acquire/removal atomicity for actual producers. Concurrent real acquire and HTTP cleanup either return a surviving pinned file or a miss with no file; the independent either/or invariant cannot be satisfied by a dangling path. This lowest concurrency seam covers late acquisition unlike the already-pinned clean case. |
| **KEEP** — crash safety: a removal that cannot rename leaves the entry whole; leftovers of a crash are swept | CA-017 defines atomic removal and recovery after crash. Filesystem permission failure must retain both original files, while independently seeded trash and old partial/scratch paths disappear. Unique rename-error and crash-recovery inputs; ordinary GC does not drive these. |
| **REWRITE** — recorded ref sets are persisted; they go when the project is deleted | Drop private cache.index and serialized ref-shape inspections; keep restart followed by GC preserving the referenced file and deletion releasing it. |
| **REWRITE** — keyframed grade + keyframed Motion: "Clean All" running in a loop during the export removes nothing it reads; identical grade states share one LUT; the LUTs, warp layer are the project's refs | Remove independently untestable LUT serialization reconstructed with production baker and private cache index counts/mutation. Keep exports during GC and without GC decoded artifact comparison; fixed elapsed clock lets cleanup prove saved project retention and release. |
| **REWRITE** — GET /api/media/:key queues the automatic derivatives the cache GC removed | Advance Date rather than mutating cache.index access state; retain real deletion and regenerated public ready states. |
| **REWRITE** — DELETE /api/media/:key waits for a derivative a job still pins; one pinned for good is left to the GC | Advance Date rather than private cache access map; retain wait, kept-file and post-release GC contracts. |
| **REWRITE** — the render key of a motion-graphic clip comes from the document; edited params release the old render | Drop private ref-set equality and hash-format assertion; use generated key only as fixture address, and assert disk protection/release under GC. |
| **KEEP** — log retention by age and size; the Remotion usage log keeps 13 months; usage reports them | CA-020 defines 30-day logs, caller budget, and 400-day usage accounting. Fixed sizes/timestamps require oldest ordinary logs to go, recent file to survive, and exactly the old half of usage records to expire; logged files are expressly outside ordinary cache GC ownership. |
| **KEEP** — the job journal is compacted: finished jobs older than 7 days beyond the newest 500 go | CA-020 specifies 7 days and newest 500 finished jobs. Submit 520 real jobs then advance eight days; prune must retain 500 and remove the oldest 20 from journal and retrieval. Unique retention boundary, distinct from crash recovery in jobs.test.ts. |

## `apps/engine/test/cache-location.test.ts`

Independent sources (bar 1): S04 CA-021. Stable seam (bar 4): Cache location HTTP job plus disk files and startup recovery journal. Non-test callers: CacheService move route and engine startup repair. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **REWRITE** — validates folders: absolute, writable, outside the data and cache folders, empty, free space | Drop human-message regexes; retain public ok/error codes and literal CA-021 cache path. |
| **REWRITE** — moves on the same disk (rename), keeps working through the links, survives a restart, moves back | Drop test-only linkTarget wrapper and imported production directory inventory; assert real filesystem and literal required CA-021 directories plus export artifact. |
| **REWRITE** — moves to another disk by copying with progress; the old files go | Drop vacuous stages.every human-copy check; explicitly skip when no second device, assert exact copied fixture bytes, result bytes and cleanup. |
| **KEEP** — a fresh start keeps the old files on request (and removes them otherwise) | CA-021 fresh mode must provide an empty new cache while preserving old files when keepOld=true, then remove old custom-cache data when false. Authored bytes and actual move jobs expose data loss or unwanted retention; same-device move preserves data rather than exercising this branch. |
| **REWRITE** — the start-up repair completes an interrupted switch and falls back when the location is gone | Use literal required paths and truthy warning rather than production path helper or human copy; retain journal recovery and physical files. |
| **DELETE** — is a local-mode feature | Only repeats token-mode 200 smoke; never requests remote mode and cannot detect the prohibition claimed by its name. Server token auth and actual cache location tests retain meaningful behavior. |

## `apps/engine/test/mg-bundles.test.ts`

Independent sources (bar 1): S08 MGC-001/010/011/013/015/021/023/031/032/036/037 and section 8; ZIP protocol. Stable seam (bar 4): ZIP bytes, schema-loader process, package/storage config, public HTTP and rendered frames. Non-test callers: MG import routes/service, editor bundle host, native export extension. Refactor bar 5: observed protocol, file, clock or media output rather than source names. Lowest-owner bar 6: these tests own the engine implementation boundary; project-model tests own commands, client tests own SDK request formatting, and browser E2E owns editor workflows. Those cannot replace this section’s engine storage/process/network failures. Overlap within this section is removed in the rows below.

| Disposition / baseline test | Failure/oracle and remaining coverage decision |
| --- | --- |
| **REWRITE** — extracts stored and deflated entries and refuses unsafe paths | Exercise absolute-path rejection through ZIP extractor rather than private safeEntryPath export; fixed unsafe archive bytes remain the security oracle. |
| **KEEP** — hashes paths and bytes deterministically | MGC-001 content addressing must identify copied bundles equally and edited asset bytes differently; two authored folders and a changed text file provide a relational oracle independent of hashing implementation. Version bytes are read from authored HTML. Lowest bundle identity seam; import tests only cover one bundle. |
| **REWRITE** — refuses projects that do not pin remotion 4.0.499 (MG_REMOTION_VERSION with a hint) | Remove exact hint wording; retain documented pin, error code and required/found versions. |
| **KEEP** — writes the template pinned to 4.0.499 with a schema module and manifest; refuses non-empty dirs | MGC-015 scaffolding must emit a runnable pinned package and refuse destructive overwrite/relative paths. Written package dependencies must equal literal 4.0.499 and invalid destinations return 409/BAD_REQUEST. This owns generated package config; import tests consume already-built fixtures. |
| **KEEP** — converts the fixture schema module (zod 4) in a child process | MGC-011 project-supplied Zod 4 schemas must preserve title min/max, accent pattern and integer delay bounds in exported JSON Schema. Authored fixture declarations independently supply these literal constraints; subprocess loader is lowest stable compatibility seam, and import metadata does not test all constraints. |
| **KEEP** — converts zod 3 schemas with zod-to-json-schema and reports broken modules as warnings | MGC-011 explicitly supports schema-module compatibility and graceful warnings. A separately authored zod/v3 Card declares maxLength10/integer; crashing and missing modules must report warnings rather than reject the import. Unique legacy-library/process failure boundary, not duplicated by Zod 4 case. |
| **KEEP** — takes the manifest first, then the schema module, then inference; merges UI hints | MGC-011/036 independently specify manifest-over-module precedence and wildcard/per-composition text declarations. Conflicting authored inputs force literal winning metadata including disabled wildcard field. buildCompositionInfos is production import metadata boundary; real import fixture lacks conflicting declarations. |
| **KEEP** — changes with props, bundle, size, fps and range — never with key order | MGC-031 content address must change when rendered content/timing changes and be stable for JSON key-order-only edits and preview/master quality. Authored equivalent/nonequivalent requests give independent equality/inequality oracles. Lowest render-key contract owner; project composition key-order-only test is deleted in coordination. |
| **REWRITE** — serves bundle files (Range, traversal-safe) and the live host page; caches and GC | Seed through public media registry instead of private registerBundle cast; retain route bytes/security/cache lifecycle. |
| **REWRITE** — reports features.mgBundles; validates imports; refuses unknown bundles and non-rebuildable ones | Seed through public media registry rather than private registerBundle cast; preserve import/rebuild error contracts. |
| **REWRITE** — bundle uploads are completed by the import, not by the media registry | Remove exact explanatory copy; keep conflict status, purpose-specific bytes and one-shot handoff. |
| **KEEP** — test 2: imports the project — Title schema from the module, Badge inferred, manifest hints | S08 section8 test2/MGC-010/011: real project import must surface Title module schema, Badge inferred schema, authored defaults and manifest hints to clients. Independent fixture package/compositions supply concrete expected data; unlike schema-loader unit tests this catches bundle module discovery and import wiring failures. |
| **KEEP** — test 2: a zip of the built bundle imports on the web (upload) path | S08 section8 test2/MGC-010: browsers upload ZIP bundles and must recover identical bundle content identity, uploaded source metadata and composition catalog. Real ZIP bytes and original imported bundle are a relational storage oracle; unique upload-to-import handoff, while uploads.test owns ordinary media chunks. |
| **KEEP** — tests 5 + 6: native export with a cached master, frame-exact, straight alpha; cache hits and invalidation | S08 section8 tests5/6/MGC-031/032 specify frame-exact composition inclusion and straight-alpha ProRes4444 masters. Independent direct Remotion renders, known flat background and neighboring-frame negative controls constrain native decoded pixels; actual cache hit and prop-edit job behavior protect reuse/invalidation. This is the lowest complete export integration owner; pure key tests cannot detect stale files, wrong offsets or halos. |
| **REWRITE** — hybrid text layers (S08 §8 test 9): a text + style edit renders a new master; the export is frame-exact with the embedded font | Drop text/style declaration inventory already owned by project metadata tests; retain independently rendered text/font artifact comparisons. |
| **REWRITE** — measures text layout in the engine browser (S08:MGC-037): clipped name, quote off frame and outside its box | Retain public found/visible and specified overflow issue codes; delete incidental box/style/row counts and five-second cache timing replay. |
| **REWRITE** — rebuilds a watched project after a source edit: new bundle hash, new master (MGC-013) | Drop private watcher membership inspection; retain source edit producing public rebuilt event/new identity and invalidated master key. |

## Support and seam plan

Remove `linkTarget` (zero production callers), internalize cache constants used only by tests, `emptyRefs`, and `safeEntryPath` after caller checks. Make cache index private once tests stop touching it. Keep real cache pin/open/live-document adapters: services register them in production. Replace direct private MG registration with public MediaRegistry fixture setup. Keep clock configuration/public service options unless removed by this cleanup; do not broaden production changes beyond demonstrated test coupling.

Additional pre-edit seam finding: CacheService startup/delay/grace/orphan/clock knobs have zero callers; remove these unused injection options. `autoTimers` has a production caller in tools/services for JASPER_CACHE_AUTO_GC, so keep it. Move VITEST-specific automatic-GC disabling out of production into Vitest environment configuration using that existing production option; runtime behavior outside tests remains unchanged.

Generated baseline title `\`${name}: file agrees with the vector\`` expands to the four fingerprint rows above (empty, abc, exactly 8 MiB, and 9 MiB). Every expanded case is KEEP; the committed Python-hashlib literals, not fingerprintFile, provide the expected digest.

Final seam review: `settingsStore` has only same-class callers and is now private alongside the index; the now-constant grace getter and unnecessary clock closure are gone. `bundleMediaKey` has only same-file production callers and no test callers, so its unused export is internalized.

## Completed cleanup and validation handoff

Implementation is complete for these eleven files (four tests deleted; remaining changes narrow assertions/support). Engine-wide rendering, media and processing decisions are in sibling `test-cleanup-engine-*-round2.md` ledgers. Production behavior was preserved in this partition; unused exports/wrappers/config injections were removed, and test runner configuration now uses the real automatic-GC environment option rather than a production `VITEST` branch.

- Engine typecheck passed both before and after the final edits (`/tmp/engine-typecheck-final.log`). Scoped Biome and `git diff --check` passed.
- Initial parallel eleven-file baseline completed with 78 passed, 17 failed and six gated skips in 337 seconds. Most failures were the default five-second harness deadline under severe shared-host load. Cache orphan count also failed after the preceding racing-GC test timed out and continued cleanup. Real FFmpeg cancellation timed out during its pre-cancellation progress wait, before measuring the specified five-second cancellation bound.
- A single-worker post-edit check reached cache (12 passed, three failures: race harness timeout, ensuing orphan count, journal harness timeout) and jobs (eight passed, one pre-cancellation setup wait failure). It was explicitly stopped when the root agent launched the authoritative full repository run with a 120-second CLI harness deadline. These incomplete scoped runs are not reported as passing.
- Root owns final repository lint/typecheck/tests and opt-in media/E2E validation. No retained test was deleted to mask these baseline failures, and no behavior/performance threshold was weakened.

Pre-edit harness adjustment: `apps/engine/test/jobs.test.ts` / `cancels a running ffmpeg job within 5 s with no child process left and removes partials` exhausted a ten-second setup wait before t0 in the final root run under unrelated host compiler load of 80–135. Raise each of the two startup/progress setup waits to 60 seconds and the total harness budget to 180 seconds. The actual cancellation clock still starts immediately before cancel and still requires less than 5000 ms, no live children, and no partial output. No production changes. Root will rerun the failed files; scoped Biome/diff checks follow this edit.

Final root rerun: all 9 job tests passed, including the unchanged five-second cancellation requirement after real FFmpeg startup. Full repository results are in [the completion report](test-cleanup-summary-round2.md).
