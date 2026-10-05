# MCP cleanup round 2 — completed cleanup and disposition ledger

Scope includes the fast-forwarded origin/main 87ebec9 additions (cache, transitions, processing source ranges, composition text, tracking simplification). No local AGENTS.md was present; host instructions apply. Commands: `pnpm exec vitest run apps/mcp/test`, `pnpm --filter @jasper/mcp typecheck`, `pnpm exec biome check apps/mcp`. Root agent owns repository gates.

## Six-bar evidence convention

Every KEEP/REWRITE row names (1) independent WP/spec/protocol requirement, (2) recognizable failure, (3) fixed input/expected value or external file/byte oracle, (4) stable API/seam, and (6) the distinct lowest owner/remaining stronger coverage. For (5), all retained assertions observe protocol results, persisted document/state, actual process lifecycle or decoded bytes; none assert source identifiers/private request trees, so behavior-preserving implementation changes preserve them. A mock supplies external input only; actual production mapping/reducer produces the asserted output. Per-row differences from this convention are stated explicitly.

Risk for every KEEP/REWRITE is loss of the named behavior; fixture inputs and outputs must remain available. DELETE risk is low where the named stronger owner remains; private forwarding call shapes and unspecified sampling/layout/wording intentionally cease being gates. Validation for each row is `pnpm exec vitest run apps/mcp/test/<file>.test.ts` (deleted files use listed stronger owner plus remaining MCP suite). Composition rendering also requires `MG_E2E=1`.

Non-test seam callers: `createJasperMcpServer` is called by CLI and engine HTTP MCP; every register*Tools function is called by server; `discoverEngine`/`withEngine` by EngineLink/context; `decodePng` by tools/animation; export settings helpers by tools/render. Clipboard registerTools remains production-used even after its test harness disappears. `candidateAppdirs`, `probeHealth`/`HealthResult`, `guardedFetch` have only same-module non-test calls and lost exports after tests stopped importing them. FixedEngineLink is instantiated by engine routes with URL/token only; extra injected fetch/deadline constructor parameters have no production callers and are removed. EngineLink timeout remains CLI-configurable.

## `apps/mcp/test/unit.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `prefers explicit URL/token (flags over env)` | WP-MCP discovery precedence; flags select URL 1 over env URL 2, env supplies token. Wrong engine/token is externally visible. Discovery config API owns precedence; live stdio covers only runtime-file success. |
| REWRITE | `reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries` | WP-MCP stale-runtime skipping and token override; fixed dead PID and unreachable/live URLs must select live runtime and explicit token. Remove log-copy assertions. Discovery config API is the lowest controllable seam; stdio cannot independently select stale candidates. |
| KEEP | `falls back to the default dev port` | WP-MCP default http://127.0.0.1:47900 config fallback; wrong endpoint prevents connecting. Discovery API with fixed network responses uniquely owns fallback. |
| REWRITE | `probeHealth rejects non-engine answers` | WP-MCP discovery must not accept an unrelated HTTP service; exercise discoverEngine and expect null, rather than exported private probeHealth. Fixed non-engine JSON is the independent input, no other case covers false-positive discovery. |
| KEEP | `EngineLink reports an actionable error when nothing runs` | WP-MCP no-engine error contract; EngineLink must report ENGINE_NOT_FOUND and the actionable --start-engine flag. No-engine condition is distinct from retry/timeout. |
| REWRITE | `withEngine re-discovers once after a network failure` | WP-MCP blind-retry regression: a failed read is retried after rediscovery. Replace invented client IDs/private collaborator calls with real EngineLink and EngineClient reading an HTTP response after one refused request. Fixed successful project list and two transport attempts catch unavailable read recovery; other cases prohibit unsafe write retries. |
| REWRITE | `a request that never answers ends with ENGINE_TIMEOUT instead of hanging` | WP-MCP unbounded-wait regression: real EngineLink/EngineClient with configured 40 ms deadline must yield ENGINE_TIMEOUT once, under 5 s, without token. Use production configurable link rather than FixedEngineLink test-only injection parameters. Lowest deterministic deadline owner; real stdio does not hang a transport. |
| REWRITE | `a write cut off mid-flight is reported, not retried (it may have been applied)` | WP-MCP blind-write retry regression: real EngineLink must send a reset POST only once and expose ENGINE_CONNECTION_LOST. Replace direct guardedFetch export/client fake with configured link; transport count represents duplicate user mutations, not a private method count. No other test simulates ambiguous delivery. |
| REWRITE | `a write that never reached the engine, and any read, stay retryable NETWORK errors` | WP-MCP never-sent write/read retry classification: configured real EngineLink client must preserve NETWORK for refused POST and reset GET; remove guardedFetch test export. Fixed OS codes and public error code are independent of guard implementation; ambiguous POST is separately owned. |
| KEEP | `maps tool, engine and transaction errors to isError results with hints` | WP-MCP tool error envelope and hints: ToolError explicit hint, engine detail E_NO_SESSION and NETWORK must serialize isError/code/hint. Error formatter is the lowest stable output seam; tool workflows test individual errors, not code precedence. |
| DELETE | `builds engine ExportSettings from a preset` | Preset declaration restatement includes literals copied from preset implementation and repeats draft sizing covered by real stdio ffprobe export. No independent CRF/bitrate preset oracle beyond production declaration; config owner functions still have real render-tool callers. |
| KEEP | `the --version CLI reports the package version` | Public CLI --version must exit successfully and print package release metadata; CLI execution versus package manifest is an independent packaging contract, not two production declarations. No other test invokes this exit path. |

## `apps/mcp/test/animation.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| REWRITE | `decodes RGB and RGBA rows of every filter type` | PNG protocol scanline filters 0–4, RGB/RGBA and split IDAT must recover independently generated raw sample bytes. decodePng is the production image-bytes seam used by render_frames; corrupted filters damage contact sheets. Remove the test encoder that mirrored the decoder predictor; freeze PNG byte vectors, independently decoded with external FFmpeg before writing the test, with literal RGBA expected bytes. Real engine PNGs do not exercise all filters. |
| REWRITE | `decodes greyscale (with alpha) to RGBA and rejects what it does not support` | PNG grayscale+alpha expansion and unsupported input/depth rejection; fixed [10,10,10,200,30,30,30,40] oracle and malformed signature/16-bit IHDR. decodePng is lowest byte protocol owner, distinct from RGB filters; freeze the external-FFmpeg-verified grayscale vector and remove shared inverse-encoder support. |

## `apps/mcp/test/clipboard.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| DELETE | `copy_clips → paste_clips across projects (linked pair, media added once, new ids)` | Private registerTool callback harness bypasses MCP schema/protocol and replays project clipboard behavior. packages/project/test/clipboard.test.ts owns cross-project media identity/new IDs/placement at the lower stable transaction seam. Claimed linked pair fixture actually has video only. No unique public MCP contract proved. |
| DELETE | `copy_items → paste_items deep-copies a sequence into a bin` | Private callback harness repeats deep-copy project.pasteItems behavior already owned by packages/project/test/clipboard.test.ts, with fake engine executing the same project transactions. No unique stable MCP seam; remove entire harness/video fixture. |

## `apps/mcp/test/cache.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| REWRITE | `get_cache_usage reports MB per kind (only kinds with entries)` | S04 CA-019 public MCP compact cache report: fixed byte fixture must become 300/100/150/50 MB, including per-kind 12 MB and protected annotation flags. SDK result is lowest owner of MB conversion (engine exposes bytes); remove exact current label/field inventory and unrequired omission of empty kinds. |
| DELETE | `set_cache_location checks the folder, starts the move and waits for it` | Fetch mock fabricates folder validation, move completion and final path then test asserts forwarding/canned result. Engine cache HTTP/disk tests own real relocation, directory rejection and waiting. No independently observed move; remove fake move routes/job fixture. |
| DELETE | `clean_cache forwards mode and kinds; bad modes and kinds are rejected` | Private HTTP call capture and copied canned report assert forwarding/declaration shape. Engine cache route/GC tests own actual modes, protection, deletion and invalid kinds; remaining MCP cache summary owns units and destructive annotation. Remove fake cleanup route/report fixture. |

## `apps/mcp/test/transitions.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `uses the open editor’s default types and alignment` | S10 TUI-034: editor preferences choose audio/video effect IDs and alignment. SDK call feeds real project transactions; fixed expected persisted transition summaries distinguish wrong medium/default preference. Lowest MCP preference-resolution owner; headless integration cannot supply editor preferences. |
| KEEP | `lets call arguments override the editor value by value` | S10 TUI-034 per-value call-over-editor precedence: explicit video/alignment preserve editor audio, all values override. Real transactions and fixed effect IDs are oracle; distinct from all-editor and invalid preferences. |
| REWRITE | `falls back to the built-ins without an editor and for invalid editor values` | S10 TUI-034 invalid preference fallback: wrong-medium video, unknown audio and alignment must become built-ins. Keep only invalid-editor branch; headless no-editor scenario is already covered by real stdio integration. SDK output from real transactions is lowest mixed-invalid-preference owner. |

## `apps/mcp/test/templates.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `reports renderer, native and a compact params summary with keyframable flags` | S11 ANA-003/ATP-006 catalog describes renderer and which numeric/color parameters are keyframable. Fixed schema fixture gives numeric=true/text=false/fframes=false. SDK response transforms engine catalog, so no engine/project test owns this MCP summary. |
| DELETE | `renders a one-clip document through the still path and returns the PNG` | Canned 1x1 PNG ignores requested scene. Test checks private request snapshot and even-width layout plus canned PNG signature; no rendered title failure can make it fail. Real engine render tests own rendering and stdio integration owns image transport. Remove captured Still documents/PNG fixture when unused. |
| DELETE | `returns intro, hold and outro frames with frames: 3` | Exact intro/hold/outro frame arithmetic mirrors current implementation and private request list; ANA-003 requires previews but does not specify these sample midpoints. Canned PNG cannot prove phases. Real motion template rendering owns visible phases. |
| REWRITE | `rejects invalid params with E_INVALID_PARAM before rendering` | S11 ANA-003 invalid template parameters reject E_INVALID_PARAM for each invalid name/value independently. Keep SDK error code, remove exact prose and private render-call count; supplied wrong type/name fixtures independent of implementation. Lowest tool JSON-schema validator owner. |
| REWRITE | `keeps RENDERER_UNAVAILABLE for fframes templates` | S11 ANA-003 explicitly preserves RENDERER_UNAVAILABLE for fframes and missing template gives E_NOT_FOUND. Keep SDK codes; remove prose/private still counts. Distinct renderer routing contract not duplicated by engine rendering. |
| REWRITE | `explains a failed still (Remotion unavailable) with the Remotion hint` | S11 ANA-005 failed preview must expose engine BINARY_MISSING and actionable JASPER_BROWSER_EXECUTABLE key. Fixed failed-job input and SDK error output independently distinguish lost hints; remove exact prose and generated job ID assertion. Preview completion path differs from direct render/export failures. |
| KEEP | `sets static params and preserves template defaults` | S11 ANA-003 static MCP parameter updates preserve omitted template defaults. Actual project reducer stores Launch/150/center and SDK rereads values; fixed input/default fixture supplies oracle. Lowest tool-to-command mapping owner; project tests cannot catch incorrectly constructed MCP commands. |
| REWRITE | `keyframes numeric and colour params of anime templates (setAnimated + set at the frame)` | S11 ATP-006/ANA-003 numeric/color animation and time requirement. Keep stored keyframes 60/200/red, static title Big, E_INVALID_PARAM for text animation/missing at; remove exact hint text. Real reducer behind SDK is stable mapping owner, independent of reducer keyframe unit tests. |
| REWRITE | `validates the clip, the param names, values, times and the renderer` | S11 ANA-003 clip/param/time/renderer validation must reject with E_NOT_FOUND/E_INVALID_PARAM and preserve document; valid fframes static update must persist size 50. Replace exact error prose with error codes; fixed bad inputs and unchanged document are independent. Distinct validation boundaries not exercised by successful updates. |
| REWRITE | `render_frame: TEMPLATE_NOT_INSTALLED and a missing browser` | S11 ANA-005 direct capture failure preserves TEMPLATE_NOT_INSTALLED/RENDER_FAILED and browser configuration hint. Remove exact remediation prose; retain actionable environment key for browser failure. SDK error boundary is unique direct-render path. |
| REWRITE | `start_export: plan errors and Remotion warnings carry hints; the happy path skips capabilities` | S11 ANA-005 exports preserve plan blocker error codes/data and actionable browser setup hint. Remove exact copy/passthrough warning comparison and obsolete title about private capabilities call shape; assert caller-visible plan error data only. SDK export-planning path is distinct from still completion and failed jobs. |
| REWRITE | `wait_for_job: a failed export explains Remotion; cancelled jobs get no hint` | S11 ANA-005 failed export polling retains RENDER_FAILED plus browser key; JOB_CANCELLED receives no misleading browser advice. Drop third generic-ffmpeg copy assertion already owned by generic errors. Fixed terminal jobs, SDK errors and independent codes are unique wait_for_job mapping. |

## `apps/mcp/test/integration.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| REWRITE | `discovers the engine, edits media, renders a frame, and exports a playable video` | WP-MCP critical stdio edit/export workflow: real media becomes linked 30-frame video/audio, PNG 320x180 and playable 1280x720 30-frame video. SDK plus independently decoded artifact uniquely covers process/discovery/edit/export orchestration; retain export and PNG under test-results/mcp before temp cleanup. |
| KEEP | `keeps the engine token out of MCP responses and stderr` | WP-MCP security: configured random actual engine token must never appear in successful/error MCP responses or stderr. Real stdio boundary catches leaks no HTTP-only security test can see. |
| KEEP | `serves project resources and the edit-video prompt through MCP` | WP-MCP resource/prompt protocol: document URI resolves requested project and edit-video propagates caller goal. Real SDK resource/prompt transport is lowest owner; tools cannot cover these separate MCP methods. |
| KEEP | `dry runs leave the project unchanged and destructive edits require approval` | WP-MCP security/transaction dryRun flag transport: revision unchanged on dry run, destructive track removal denied with E_APPROVAL_DENIED. SDK adapter can lose dryRun or approval semantics independently of engine tests; real project state/error code provides oracle. |
| KEEP | `creates, edits, applies defaults, and removes transitions through MCP` | S10 TUI-032…034 public MCP transition lifecycle and newly merged per-medium project defaults. Requested effects/durations/removed IDs and headless built-in alignment must appear in readback. SDK orchestration owns aliases/default-length command construction; project tests cover primitives and transitions unit tests cover editor preference precedence only. |
| REWRITE | `persists text animation changes and returns a PNG contact sheet` | S11 ANA-002/004 text animations persist independently requested presets/durations, 50 fps converts 1 s to 50 frames, contact sheet returns requested frames as PNG. SDK resource readback is stable unique time-argument adapter seam; retain contact-sheet PNG artifact. |
| KEEP | `stores a shape with the requested geometry and rejects invalid ellipse corners` | S11 SHP-008 public shape creation maps requested rect 640x160/radius24 to stored shape data and ellipse radius rejects E_INVALID_PARAM. This is authored content geometry/API data, not layout appearance. Resource readback catches tool argument mapping absent from project primitive tests. |
| KEEP | `starts an engine and stops it when the MCP client closes` | WP-MCP --start-engine lifecycle: process starts reachable private-port engine and removes runtime file after client close. Actual process/file lifecycle is unique CLI ownership, independent of engine-alone shutdown tests. |

## `apps/mcp/test/processing.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `marks processing settings as destructive in the MCP tool schema` | S07 PRA-001 public MCP destructiveHint protects remote-media destination settings. SDK tools/list annotation is protocol metadata, not internal declaration inventory; engine auth checks cannot prove clients see the warning. |
| DELETE | `lists the bundled SPAN model with its licence` | Bundled SPAN installed/license/author repeats actual model catalog HTTP test through pass-through wrapper; engine processing catalog test is the lowest owner. No MCP-specific behavior in expected values. |
| DELETE | `test_remote_executor without settings is a clear "not configured" error` | REMOTE_NOT_CONFIGURED passthrough plus exact message repeats engine processing route rejection; remaining error formatter owns MCP envelope. No additional observable failure over stronger owner. |
| KEEP | `set_processing_settings needs the user in an open editor` | S07 PRA-001 remote destination requires user approval in open editor: E_NO_SESSION and unchanged settings through real SDK. Security-specific MCP adapter must carry approval project; distinct from annotation metadata. |
| REWRITE | `process_clip (denoise, local, replace, wait) swaps the clip to the processed version` | S07 PRA-001 critical process/replace workflow produces a new registered version, updates clip source, preserves derivation, then restores original. Real SDK and document readback catch multi-step MCP orchestration that engine processing artifact tests cannot. Fixed source identity relationships independent of tool code; retain processed document artifact before temporary appdir removal. |
| KEEP | `process_clip with handles processes only the clip range (+ handles) and keeps the source frames` | New remote S07 PRA-003 range+handles: original [20,40) plus six handles yields [14,46), replacement sourceIn=6 frames, restoring original=20. Fixed arithmetic from independently specified source frame rule and document resource oracle; unique tool range/registration/remapping orchestration. |
| REWRITE | `use_media_version refuses a version that does not cover a clip, or trims with fit: "trim"` | New remote S07 PRA-003 fit: version [14,46) cannot cover source [0,30); reject E_OUT_OF_MEDIA or trim head14 giving start114/duration16/sourceIn0. Keep stored numeric result, remove exact error sentence. SDK fit option mapping is distinct from lower project media remapping. |
| REWRITE | `import_media links a render with a sidecar to its source; set_media_source_range; replace_footage keeps timing` | New remote S07 PRA-003 external grade sidecar import and explicit source-range/replace_footage timing: fixed first frames 5/10/12 produce stored inpoints15/25/13. SDK/filesystem interoperability owns orchestration; replace error prose assertion with E_INVALID_PARAM for derived version. No stronger test combines sidecar registration with tool source remap. |

## `apps/mcp/test/color.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `imports a .cube LUT and reports the broken one with its line number` | S06 agents import LUT public contract: real valid .cube returns size33/dimension3/fixture title, broken number identifies line, relative path rejects NOT_ABSOLUTE. SDK filesystem import uniquely adds project media and agent error translation beyond raw LUT parser. |
| REWRITE | `grade_clip grades in one Agent change and render_frame shows it` | S06 agent grading is one undoable change; requested grade visibly changes rendered pixels, exposure12 clamps5, malformed fields reject. Retain one public doc.changed event and independently decoded PNG; drop exact Agent label/ID prefixes unrelated to result. SDK orchestration is lowest owner of grouping whole grade. |
| KEEP | `get_grade returns the evaluated values and LUT names` | S06 get_grade maps stored numeric/curve/wheel values and LUT identity to agent summary, default clip-start evaluation. Fixed earlier caller inputs and imported LUT metadata are independent oracle; scalar keyframe case lacks full grouped summary coverage. |
| REWRITE | `keyframed params need a time: rejected without one, keyed at `at`` | S06 animated grading requires at and preserves original keyframe: no-time/out-of-range reject E_INVALID_PARAM, frame60=-30/frame0=40. Remove exact error prose/hint copy. SDK-to-keyframe mapping/readback is unique stable owner. |
| KEEP | `instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change` | S06 instance new and copy_grade replace destination stack in one change with fresh effect IDs and preserved keys. Fixed source grade and decoded target PNG catch stale destination/wrong stacking; distinct from single-clip grading. |

## `apps/mcp/test/tracking.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| KEEP | `add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth` | S09 TRA-001…003 explicitly requires critical MCP tracking workflow: actual engine tracks independent plate ground truth, applies/simplifies keys and emitted PNG corners stay within3px. test-results/mcp PNGs are retained artifacts. Lowest workflow owner catches incorrect tool coordinate/time/target mapping beyond engine tracking and project apply primitives; newly merged simplification assertions reviewed as source-data keyframe contract, not CSS geometry. |
| DELETE | `set_corner_pin places corners in sequence pixels` | Checks only echoed normalized corner coordinates, not persisted pin or rendered result; arithmetic mirrors conversion of default full-frame shape. Stronger engine warp pixel tests plus retained full MCP tracking/render artifact own corner-pin behavior. No isolated echo contract required. |

## `apps/mcp/test/compositions.test.ts`

| Disposition | Baseline test | Evidence / retained owner / risk |
| --- | --- | --- |
| REWRITE | `imports, places, edits and renders a composition; errors carry hints` | S08 MGA-001/002/003 critical public SDK import/edit/prerender/text workflow: fixed fixture title/type/props, invalid scalar text input, expected text/style values and single revision, MG_TEXT_LONG/MG_TEXT_CLIPPED codes and MG_REMOTION_VERSION provide independent oracles. Actual engine/browser renders changed PNGs, which remain in test-results/mcp. This is the lowest owner of multi-tool MCP orchestration, beyond engine composition primitive tests. Remove exact style-key inventory, arbitrary measured width and exact remediation prose; retain warning codes because overflow detection is explicitly a user-facing API contract. All six bars follow the convention above; the newly merged text workflow is included. |

## Implemented support/seam cleanup

Removed the entire private clipboard callback harness and media fixture, canned preview PNG/captured scene requests, cache relocation/GC fake routes and jobs, empty-cache fixture, mirrored PNG predictor encoder/noise generator, and unused success/warning stubs. PNG vectors were independently decoded with system FFmpeg before freezing the literal byte oracles. Removed exports of `probeHealth`, `HealthResult`, `candidateAppdirs` and `guardedFetch`; removed unused fetch/deadline arguments from production `FixedEngineLink`. CLI-configurable `EngineLink` remains the request-safety seam.

The ambiguous-write test now uses an actual rediscoverable link, so deleting the guard would really replay the POST; the old fake returned the same client and could suppress retries for the wrong reason. Error assertions now prefer codes and actionable public keys over exact prose. Valid 16-bit PNG input ensures unsupported-depth rejection cannot pass merely because the fixture is truncated.

Validation in progress: focused pre-edit 32/32 passed; rewritten focused 27/27 passed; MCP typecheck and Biome passed. Real-engine color 5/5 passed. Concurrent engine-startup runs exceeded 90/120-second deadlines under host contention; isolated-port serial rerun is in progress. No test timeout was weakened.

After the engine owner removed implicit VITEST behavior, subprocess test environments explicitly configure `JASPER_CACHE_AUTO_GC=0` (the production environment option), keeping asynchronous GC out of these unrelated MCP contracts. No production-only testing flags added. Root owns the full default suite; the duplicate serial run was stopped at root request while tracking failure is diagnosed independently. Final PNG/cache/template cleanup recheck passed 13/13.

Retained tracking workflow detected `TRACK_FAILED: quadInwardLines is not defined`. Engine cleanup owner restored `quadInwardLines`, `quadInsideDistance`, and `intersectLines` exports: the worker serializes `Object.entries(Geometry)`, making these real dynamic production callers. Fresh-process tracking validation follows that fix; test retained unchanged.

Fresh-process tracking recheck after engine fix: **1/1 passed**, 80.64 s, all three ground-truth PNG artifacts regenerated. Final disposition totals: **58 cases; 10 DELETE, 26 REWRITE, 22 KEEP**. Test-only LOC: 148 added / 648 removed, **net −500**. Production behavior is unchanged by MCP cleanup.

Optional browser composition workflow with `MG_E2E=1 MCP_MG_TEST_PORT=49664`: **1/1 passed**, 304.09 s, including newly merged composition text edits/layout warnings, prerender, and retained before/after PNG artifacts. Scoped Biome and final diff checks pass. Full default suite remains owned by root; the redundant agent default run was intentionally stopped in favor of that gate.
