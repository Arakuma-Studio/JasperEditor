# Engine media/core test cleanup

Scope: 66 original engine test files (16,462 lines), excluding the render and sound owners. Test-declaration/target inventory is explicit below; parameterized and generated fuzz cases inherit their declaration's outcome and are expanded by the runner. The two observational benchmark templates expand to 12 deleted cases.

Original baseline declarations: 413 — DELETE 5, REWRITE 11, OPTIMIZE 19, CONSOLIDATE 9, KEEP 369. Thirteen additional fuzz-target definitions are listed for completeness and inherit their retained wrapper's outcome; they are not counted twice in the declaration totals. Four workflow pairs become four surviving owners; a fifth owner moves the roto-reference contract into real cache cleaning. The five deleted declarations expand to fifteen runtime cases, including twelve optional benchmark cases.

A row's name states the exact expected behavior and recognizable regression (the behavior is absent or wrong). Its file profile supplies the independent requirement source, oracle, stable seam and why another owner does not supersede it. These profiles apply individually to every retained row; no KEEP decision is based on coverage percentage or passing status. Numerical image/audio geometry is feature output, not UI layout.

Low-level numerical tests are retained only for credible wrong results (e.g. residual-capacity/cut labels, distance, alpha, FFT/token/time transforms, edge selection, sample depth). Their analytic/brute-force/format oracles can disagree with a different implementation. HTTP/worker tests remain when they add serialization, process, storage or authorization failures that a pure owner cannot see.

No snapshots, dependency versions, fixture recipes or runner gates were changed. Removed infrastructure: 112-line nongating delivery benchmark, unused typicalMix generator, 32-MiB allocation helper, private per-frame decoder, redundant test-only exports idsWithBodies and parseRouteTree. idsWithBodies still has its production local caller; no production behavior was changed.

## Implementation decisions

- Pruned private camera pose/bundle stages and synthetic cache dispatch table; public result owners remain.
- Consolidated order-dependent camera/reframe/range/roto workflows and moved roto reference verification to real saved-project cache cleaning.
- Removed the benchmark with no regression oracle; historical measured tables retain original commit provenance.
- Virtual time, protocol barriers, batched decodes and smaller static fixtures remove repeated work without replacing asserted behavior with mocks.
- A scoped filesystem EBUSY fault makes the crash-safety regression portable to privileged hosts; the original chmod setup cannot enforce the failure there.
- The Vitest-only `tempAppdir` helper removes only the directories it created, after the entire file's teardown. Directories remain available for restart workflows. Its import registers this cleanup before later server/worker teardown hooks; Vitest 4.1.11 defaults `sequence.hooks` to `stack` and reverses `afterAll` registration order, with no repository override. This shared lifecycle change requires the integrated engine gate; it does not clean unrelated/preexisting `/tmp` paths or claim measured wall-clock savings.
- `helpers.ts` loads `createServer` and `engineConfig` in the existing dynamic import inside `makeApp`, alongside `prepareAppdir`. Pure fixture/`ROOT`/`DocBuilder`/temporary-directory users no longer load the full engine through this helper. The API and assertions are unchanged. Independent library profiling identified this eager-import cost; the full baseline reports 1302.25 s aggregate import time across all workers, not an amount attributed to this helper or a claimed saving. Shared infrastructure optimizations are reported here separately from the declaration dispositions.

## Per-test dispositions

### `apps/engine/test/agent.test.ts`

Independent source: S01 AGT-002/020, AC-11; ARCHITECTURE §11; security-review AGT-2.

Stable seam and refactor resistance: HTTP agent routes and serialized WebSocket messages; AgentService timeout result. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal transaction revisions, marker data, error codes, protocol messages and secret exclusion; socket fixtures supply an external editor peer rather than the relay logic.

Unique failure protection: Schema discovery, headless saves/conflicts, relay routing, approval timeout/attestation, disconnect fallback and UI result forwarding are different caller-visible paths; model command tests cannot detect broken HTTP/WS transport.

Production owners inspected: `../src/agent/index.ts`, `../src/agent/mcp-entry.ts`, `../src/index.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'describes commands, queries, addressing, approvals and error codes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'publishes editor.openProject globally and reports listening editors; 404 for unknown projects'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports the HTTP endpoint and the stdio bundle path, never the token'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'finds the bundle in a checkout and in packaged resources; JASPER_MCP_ENTRY overrides'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'applies, saves a new revision and publishes doc.changed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects destructive transactions with E_APPROVAL_DENIED and unknown projects with 404'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects a stale expectedRevision touching a changed entity and fast-forwards otherwise (S01 AC-11)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'relays transactions and queries to the session that holds the lease and forwards its events'` | OPTIMIZE | Waits for the observable doc.changed event condition rather than a fixed 30 ms sleep; serialized request/response/event assertions remain. |
| `'asks the session for approval; approve relays with approved:true, deny returns E_APPROVAL_DENIED'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'falls back to headless when the session disconnects before a request'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'returns E_APPROVAL_TIMEOUT when nobody answers the approval'` | OPTIMIZE | Virtual time advances the documented approval/relay timeout; the same public result/error/lease/approval assertions remain, with real timers restored during teardown. |
| `'ignores approval answers from connections that never said hello'` | OPTIMIZE | Virtual time advances the documented approval/relay timeout; the same public result/error/lease/approval assertions remain, with real timers restored during teardown. |
| `'returns E_NO_SESSION on a relay timeout while the lease is live, headless once it expired'` | OPTIMIZE | Virtual time advances the documented approval/relay timeout; the same public result/error/lease/approval assertions remain, with real timers restored during teardown. |
| `'rejects oversized transactions (limits)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'409 without an editor window; relays to the window and answers with which window replied'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/browse.test.ts`

Independent source: ARCHITECTURE D-47; S04 SC-001 and MS; docs/wp-notes/imports.md.

Stable seam and refactor resistance: Media Browser HTTP endpoints backed by real files, symlinks, FFmpeg and a recording local HTTP server. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Auth/status codes, fixture bytes/file types, natural filename order, declared 2000-entry safety bound, decoded JPEG signature and an independently recorded absence of network requests.

Unique failure protection: Browser-by-path access has symlink, fetch-site and SSRF checks that registered media endpoints do not exercise; listing, cap, probe/thumbnail and refusal cases have separate observable failures.

Production owners inspected: `../src/index.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'classifies files by extension, case-insensitively'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lists importable files and folders, hides the rest unless asked, follows symlinks'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'caps huge folders and says so'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lists the fixtures folder, probes a clip, makes a thumbnail and serves preview bytes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses bad paths, non-media files and missing folders with typed errors'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serves bytes by what a path resolves to: a media-named symlink to another file is refused'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses requests a browser makes for another site (no embedding of local files by path)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'does not follow a playlist-like file to the network when it is only looked at'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'is refused by a non-local engine'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/cache-location.test.ts`

Independent source: S04 CA-021.

Stable seam and refactor resistance: Cache-location HTTP jobs, persisted settings/links and files after a restart. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Auth/validation errors, authored file bytes, chosen paths and preserved artifacts; the output-location case needs one frame, not a one-second movie.

Unique failure protection: Same-device rename, cross-device copy, fresh/keep-old modes, invalid destinations and interrupted/unavailable-drive recovery are independently specified filesystem outcomes.

Production owners inspected: `../src/cache/location.ts`, `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'validates folders: absolute, writable, outside the data and cache folders, empty, free space'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'moves on the same disk (rename), keeps working through the links, survives a restart, moves back'` | OPTIMIZE | The output-location proof exports one 64×36 frame instead of one second at 640×360; the route/job/output path, relocation links, file bytes and restart assertions remain. |
| `'moves to another disk by copying; the old files go'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a fresh start keeps the old files on request (and removes them otherwise)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the start-up repair completes an interrupted switch and falls back when the location is gone'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/cache-reference-index.test.ts`

Independent source: S04 CA-012 (claimed).

Stable seam and refactor resistance: Private cache index dispatcher. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Synthetic sets repeat the dispatcher table and use a 64-character media fingerprint as an mg-render key, whose real format is 40 characters.

Unique failure protection: DELETE: fails stable seam/refactor resistance and credible unique failure. CacheService behavior is exercised by saved media/composition/fframes/roto artifact preservation and release in cache.test.ts; no claim that those tests reproduce this artificial collision.

Production owners inspected: `../src/cache/layout.ts`, `../src/cache/reference-index.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'does not mix references with the same key in different cache namespaces'` | DELETE | DELETE: fails stable seam/refactor resistance and credible unique failure. CacheService behavior is exercised by saved media/composition/fframes/roto artifact preservation and release in cache.test.ts; no claim that those tests reproduce this artificial collision |

### `apps/engine/test/cache.test.ts`

Independent source: S04 CA-003/004/010–021 and S06 CG-056; docs/wp-notes/roto.md §2.

Stable seam and refactor resistance: CacheService/HTTP cleaning against real saved project files, pins and artifact files; actual export under concurrent cleaning. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored byte counts/ages/paths, independent file existence/content checks, explicit preservation/release policies, external decoded export pixels, specified retention bounds.

Unique failure protection: Each owner covers a different retention/protection class: saved/live/open/pinned refs, eviction, restart refs, interrupted removals, export-held LUT/warp files, regenerated derivatives, discard, composition/fframes/roto refs and log/job history. Generic cleaning cannot substitute for each owner-specific reference derivation.

Production owners inspected: `../src/cache/logs.ts`, `../src/cache/service.ts`, `../src/jobs/queue.ts`, `../src/mg/index.ts`, `../src/mg-bundles/service.ts`, `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'reports usage per kind: in use, referenced by saved projects, unused (CA-013)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'"Clean Unused" keeps referenced, pinned and recent entries and sweeps stale temporary files (CA-014, CA-017)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'"Clean All (not in use)" removes what saved projects reference but keeps open projects and running jobs (CA-014)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an open project keeps what its editor shows before the autosave (live document; integration regression)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'automatic passes: per-kind age limits, then LRU eviction under kind and total budgets; referenced entries stay (CA-003, CA-015)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'validates and persists the settings (engine/cache.json)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a lookup racing a removal either keeps the entry or misses; never a path that disappears (CA-016)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'crash safety: a removal that cannot rename leaves the entry whole; leftovers of a crash are swept'` | REWRITE | Narrowly injects EBUSY at the external rename boundary; chmod cannot cause failure under root. Real entry bytes and orphan recovery assertions remain. |
| `'recorded ref sets are persisted; they go when the project is deleted'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keyframed grade + keyframed Motion: "Clean All" running in a loop during the export removes nothing it reads; identical grade states share one LUT; the LUTs, warp layer are the project\'s refs'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'GET /api/media/:key queues the automatic derivatives the cache GC removed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'DELETE /api/media/:key waits for a derivative a job still pins; one pinned for good is left to the GC'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps trimmed preview/master renders and bundle posters; releases obsolete renders after a props edit'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the render key of a motion-graphic clip comes from the document; edited params release the old render'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'log retention by age and size; the Remotion usage log keeps 13 months; usage reports them'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the job journal is compacted: finished jobs older than 7 days beyond the newest 500 go'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/camtrack-job.test.ts`

Independent source: docs/wp-notes/three-d.md §§2/4; camera-tracker public options and serialized results; S04 ENG-002/JB-020.

Stable seam and refactor resistance: Camera solver entry point with authored projected tracks; HTTP solve/re-solve/cancel jobs with a ray-cast plate. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored focal lengths, camera paths and rotations, independent quaternion/chord and collinear-path oracles; RANSAC uses known homography plus outliers.

Unique failure protection: Fixed/specify/zoom/tripod/flat/distortion are distinct camera models. The job checks decoding, child-process serialization, cache reuse and deleted tracks; the pure solver owns numerical models. Two removed private pose/bundle tests add no user accuracy contract beyond these owners.

Production owners inspected: `../src/camtrack/core/linalg.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'solves the camera of the plate: focal length, path and rotation against the truth'` | CONSOLIDATE | Both original cases survive in one solve→cached re-solve workflow; all accuracy/cache/deleted-track assertions remain, while first is local instead of being initialized by a previous test. |
| `'re-solves from the cached tracks without the deleted points'` | CONSOLIDATE | Both original cases survive in one solve→cached re-solve workflow; all accuracy/cache/deleted-track assertions remain, while first is local instead of being initialized by a previous test. |
| `'cancels a running job (the child process is killed)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses spans shorter than two frames and unknown media'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/camtrack-solve.test.ts`

Independent source: docs/wp-notes/three-d.md §§2/4; camera-tracker public options and serialized results; S04 ENG-002/JB-020.

Stable seam and refactor resistance: Camera solver entry point with authored projected tracks; HTTP solve/re-solve/cancel jobs with a ray-cast plate. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored focal lengths, camera paths and rotations, independent quaternion/chord and collinear-path oracles; RANSAC uses known homography plus outliers.

Unique failure protection: Fixed/specify/zoom/tripod/flat/distortion are distinct camera models. The job checks decoding, child-process serialization, cache reuse and deleted tracks; the pure solver owns numerical models. Two removed private pose/bundle tests add no user accuracy contract beyond these owners.

Production owners inspected: `../src/camtrack/core/bundle.ts`, `../src/camtrack/core/geometry.ts`, `../src/camtrack/core/linalg.ts`, `../src/camtrack/core/solver.ts`, `../src/camtrack/core/types.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'recovers the relative pose from the essential matrix'` | DELETE | Private solver stages fail the stable-seam/refactor/unique bar. Surviving Fixed/Specify/Zoom/Tripod/Flat/distortion solveCamera cases and real HTTP camera job own required path/focal/rotation accuracy; no extra exact internal convergence contract is specified. |
| `'fits a homography with RANSAC despite outliers'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'bundle adjustment converges from a perturbed start'` | DELETE | Private solver stages fail the stable-seam/refactor/unique bar. Surviving Fixed/Specify/Zoom/Tripod/Flat/distortion solveCamera cases and real HTTP camera job own required path/focal/rotation accuracy; no extra exact internal convergence contract is specified. |
| `'Fixed Angle of View: finds the focal length and the path of a dolly'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Specify Angle of View: uses the given focal length'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Variable Zoom: follows a zoom during the move'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Auto Detect: a pan from a tripod is solved as a pure rotation'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Auto Detect: a scene of one plane is solved (Flat)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'solves radial lens distortion'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'can be cancelled'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses clips without features'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/cancel-partials.test.ts`

Independent source: S04 JB-020; export destination non-overwrite contract (docs/wp-notes/mcp-cli.md).

Stable seam and refactor resistance: Destination-copy file operations and JobQueue terminal state. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored original bytes, exclusively claimed filenames, AbortError/ABORT_ERR, cancelled state and absence of a partial destination.

Unique failure protection: Concurrent destination claims, abort before copying, and cancellation after copying complete are separate data-loss races; general export success does not exercise them.

Production owners inspected: `../src/export/service.ts`, `../src/jobs/queue.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'never overwrites: picks "name (2)", "name (3)" and claims the name exclusively'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports the claimed path before writing and removes it when the copy is aborted'` | OPTIMIZE | A five-byte source replaces a 32 MiB allocation because abort happens before the stream writes; the test now requires AbortError/ABORT_ERR plus claimed path and absent partial. |
| `'a cancel after the copy finished (before the job ends) removes the copied file too'` | OPTIMIZE | Awaits the queue terminal promise instead of polling every 50 ms; cancelled state and removed completed-copy output are both asserted. |

### `apps/engine/test/dejudder.test.ts`

Independent source: S07 PST and §8 acceptance matrix; AGENTS LGPL requirements.

Stable seam and refactor resistance: Real processor runtime/step boundary with independent decoded-frame/audio/geometry oracles. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored cadence/noise/block/gradient fixtures, external ffprobe/FFmpeg, bit-exact audio hashes, phase-correlation or column-profile motion metrics, explicit quality/zoom/count budgets; no renderer output is accepted merely because it exists.

Unique failure protection: Per-step conservation, quality, dejudder boundary context, no-cadence copying, smoothing caps/cuts/kernel equivalence and tiled-upscale blending have different failure modes. These legitimately expensive algorithm/format contracts remain in their required gate.

Production owners inspected: `../src/processing/proc/dejudder/harness.ts`, `../src/processing/proc/dejudder/step.ts`, `../src/processing/proc/ffio.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'copies every decoded frame when no uneven cadence exists'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/delivery-speed.bench.test.ts`

Independent source: Historical sound-design export-time reporting benchmark (no gate or independent time assertion).

Stable seam and refactor resistance: Optional benchmark with private JobQueue.entries log inspection. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Only job start/success is asserted; elapsed times are printed without an expected result.

Unique failure protection: DELETE: fails independent contract/unique protection/refactor resistance as a test. Export success and delivered audio are owned by export-lossy-true-peak, audio-deliver and preview-loudness-parity. Historical timing tables remain identified by their original commit.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| ``${kind}: ${name}`` | DELETE | DELETE: fails independent contract/unique protection/refactor resistance as a test. Export success and delivered audio are owned by export-lossy-true-peak, audio-deliver and preview-loudness-parity. Historical timing tables remain identified by their original commit |
| ``warm ${kind}: aac 256, web (the same mix again)`` | DELETE | DELETE: fails independent contract/unique protection/refactor resistance as a test. Export success and delivered audio are owned by export-lossy-true-peak, audio-deliver and preview-loudness-parity. Historical timing tables remain identified by their original commit |

### `apps/engine/test/effect-presets.test.ts`

Independent source: S01 FX-030; docs/wp-notes/effect-presets.md; AGENTS persistence safety.

Stable seam and refactor resistance: Effect preset HTTP API and on-disk library after restart. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal user names/ids/folder relationships, unknown-field preservation, typed invalid/built-in refusal, events and exact preexisting malformed bytes.

Unique failure protection: Persistence, read-only built-ins, bin cycles/deletion, import remapping and malformed-file salvage are distinct library/data-loss contracts not covered by project-local effect commands.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'saves, lists, edits, deletes and persists across restarts'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'validates presets and protects built-ins'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'nests bins, refuses cycles, deletes a bin with its contents'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'imports bundles with their bins (new ids) and reports invalid entries'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps an unreadable library aside and invalid entries in the file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/encoders.test.ts`

Independent source: ARCHITECTURE D-13; AGENTS §2; S04 ENG-011 and LC.

Stable seam and refactor resistance: Encoder selection/FFmpeg command protocol, binary/config resolution, license metadata and actual LGPL-only export/proxy. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal documented codec/container/encoder order and FFmpeg flags; authored BUILDINFO/license fixtures, external process success/failure and ffprobe artifact facts.

Unique failure protection: Configuration matrices deliberately cover hardware availability, explicit overrides, missing/partial/GPL binaries and legal notices without running every codec. Real LGPL-only export/proxy checks wiring that selector tables cannot; neither supersedes the other.

Production owners inspected: `../src/tools/encoders.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'LGPL-only list without usable hardware: exports AV1 (SVT-AV1, MP4), proxies VP9, with a message'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'VP9 exports go to WebM + Opus when libopus exists, else MP4 + AAC'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'OpenH264-only: H.264 via libopenh264 with bitrate rate control (no CRF)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'smart-rendering pieces: no B-frames for every H.264 encoder (they are joined as one raw stream)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'hardware-only: the first usable encoder in preference order wins (test encodes decide)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'full GPL build: OpenH264 before libx264; libx264 only as dev convenience; LGPL-only ignores GPL'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'honours an explicit encoder only when it is usable'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'nothing usable → null and a capability message'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'capabilities report codecs, audio and ProRes (schema-valid)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'selects prores_ks for ProRes masters: MOV with PCM, never a substitute codec'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'parses the build license and hwaccels'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'excludes hardware whose external test encode fails and honors LGPL-only/disabled configuration'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/events.test.ts`

Independent source: S04 ENG-023, FT and API events; ARCHITECTURE capability-provider contract.

Stable seam and refactor resistance: Real NDJSON HTTP stream, capability/font endpoints and served WOFF2 bytes. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored event payloads/project filters/resume ids, schema-valid wire responses, independently selected capability changes, immutable headers and WOFF2 signature.

Unique failure protection: Live filtering/replay, malformed cursor refusal, provider composition/removal and curated font serving/fallback fail independently; Broadcaster overflow alone cannot catch transport or font-path wiring.

Production owners inspected: `../src/index.ts`, `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'streams live events after an initial heartbeat, filtered by projectId, and resumes with ?since='` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects a malformed since'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports ffmpeg, native render, Remotion state and provider patches (WP-2G hook)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serves the curated font catalog and immutable font files'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/fs.test.ts`

Independent source: AGENTS §0 atomic persistence and visible storage failure; docs/project-files.md.

Stable seam and refactor resistance: Filesystem helper output/errors with real files and narrowly injected OS I/O/fsync failures. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Exact saved bytes and original error identity; dependency fault injection supplies unavailable OS failures, not the persistence outcome under assertion.

Unique failure protection: Absent/malformed JSON differs from permission/I/O/full-disk failures; post-rename durability errors and unsupported directory-fsync behavior protect different data-loss paths.

Production owners inspected: `../src/tools/fs.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'reads valid JSON and treats absent or malformed files as unavailable'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'propagates %s instead of presenting missing data'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports %s after an atomic rename'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'supports filesystems that reject directory fsync'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/fuzz-http.test.ts`

Independent source: AGENTS §0 validation/caps; docs/testing.md §4; docs/wp-notes/golden-fuzz.md.

Stable seam and refactor resistance: HTTP request boundary and archive/media/config parser entry points. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Typed error/schema oracles, destination containment, bounded/safe sanitized names, and independently malformed historical regression inputs.

Unique failure protection: General HTTP fuzzing mostly reaches preconditions; seeded reader fuzzing and exact historical native-abort/probe regressions reach parser internals with valid envelopes. Domains and historical pins are not redundant random examples.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| ``${method} ${path}`` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/fuzz-regressions.test.ts`

Independent source: AGENTS §0 validation/caps; docs/testing.md §4; docs/wp-notes/golden-fuzz.md.

Stable seam and refactor resistance: HTTP request boundary and archive/media/config parser entry points. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Typed error/schema oracles, destination containment, bounded/safe sanitized names, and independently malformed historical regression inputs.

Unique failure protection: General HTTP fuzzing mostly reaches preconditions; seeded reader fuzzing and exact historical native-abort/probe regressions reach parser internals with valid envelopes. Domains and historical pins are not redundant random examples.

Production owners inspected: `../src/imports/zip.ts`, `../src/media/probe.ts`, `../src/mg-bundles/zip.ts`, `../src/tools/process.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'an entry size or offset past the end of the file is a ZipError (it aborted the process natively)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'corrupt deflate data and NUL bytes in names are ZipErrors'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'wrong-typed fields are dropped instead of crashing; absurd values are ignored'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'unsafe integers, fractional sample rates and huge rotations still give a schema-valid probe (FUZZ=1, verify)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'no usable stream is UNSUPPORTED_MEDIA'` | REWRITE | Requires UNSUPPORTED_MEDIA rather than accepting any ToolError; a wrong failure reason no longer passes. |

### `apps/engine/test/fuzz.test.ts`

Independent source: AGENTS §0 validation/caps; docs/testing.md §4; docs/wp-notes/golden-fuzz.md.

Stable seam and refactor resistance: HTTP request boundary and archive/media/config parser entry points. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Typed error/schema oracles, destination containment, bounded/safe sanitized names, and independently malformed historical regression inputs.

Unique failure protection: General HTTP fuzzing mostly reaches preconditions; seeded reader fuzzing and exact historical native-abort/probe regressions reach parser internals with valid envelopes. Domains and historical pins are not redundant random examples.

Production owners inspected: `../src/imports/lottie.ts`, `../src/imports/psd.ts`, `../src/imports/zip.ts`, `../src/jobs/types.ts`, `../src/media/probe.ts`, `../src/mg-bundles/project.ts`, `../src/mg-bundles/schemas.ts`, `../src/mg-bundles/zip.ts`, `../src/tools/fs.ts`, `../src/tools/process.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'ZIP (imports): list + read every entry'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'ZIP (motion-graphics bundles): extract, never outside the destination'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'dotLottie archive'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Lottie .json file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Photoshop document'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'ffprobe JSON → probe (schema-valid)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'bundle manifest (jasper.mg.json)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'bundle package.json'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'upload file names'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/gaps-audio-channels.test.ts`

Independent source: Audio Channels feature contract; docs/wp-notes/gaps.md and audio-mix.md.

Stable seam and refactor resistance: Actual exported audio after a public channel-map command. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored 440/1000 Hz stereo source, external decoded output RMS/zero-crossing frequency and silence bound.

Unique failure protection: Catches output channel inversion/duplication or failure to mute in the real mixer/export wiring; schema/command tests only protect stored channel metadata.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'routes the right source channel to the left clip channel and mutes the right one'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/gaps-avc3-playback.test.ts`

Independent source: S04 smart-render playback/seek compatibility; docs/wp-notes/gaps.md.

Stable seam and refactor resistance: Chrome and Electron actual H.264 playback and seeking across copied/encoded GOPs. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Burned-in source frame numbers and expected join/seek values, terminal playback, independent immutable VideoFrame timestamps; JSON artifacts retained.

Unique failure protection: FFmpeg decoding cannot prove Chrome/Electron SPS/PPS compatibility or that playback reaches the end across joins. The two actual browser engines are separate shipped runtime contracts.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'plays to the end with correct frame codes and seeks across the copy / encode joins'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'plays in Electron with correct frame codes and seeks across the joins'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/gaps-media-jobs.test.ts`

Independent source: S04 ingest/proxy contracts; docs/wp-notes/gaps.md.

Stable seam and refactor resistance: Media-job HTTP API, actual proxy/transcode artifacts and draft export. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Source registration facts, authored destination collision names, external artifact/probe facts and independently compared draft/original framing.

Unique failure protection: Proxy rotation/attachment, copied fingerprint and codec, invalid requests and draft warning/output geometry are different producer/routing contracts from automatic derivatives.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'creates proxies at a preset size that pass the attach check (rotation kept)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'ingest copies verify the fingerprint; transcodes write ProRes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses unknown presets, relative folders and unknown media'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Use Proxies warns about draft quality and renders at the original size'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/gaps-project-manager.test.ts`

Independent source: Project Manager collect/consolidate contract; docs/wp-notes/gaps.md; DATA-3.

Stable seam and refactor resistance: Plan/job HTTP endpoints, copied project/media and independently decoded rendered frame code. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Known authored use range/handles, no destination writes during planning, exact source bytes for collection and burned-in frame 42 after consolidation.

Unique failure protection: Disk estimates, trimmed-handle rebasing and whole-file non-overwriting collection fail differently; interchange exports do not own media consolidation.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'estimates the disk space without writing'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'consolidates the used part with handles; the copy shows the same frames from its own file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'collects whole files (same bytes) and refuses to overwrite an existing copy'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/gaps-reframe.test.ts`

Independent source: Auto Reframe contract; docs/wp-notes/gaps.md.

Stable seam and refactor resistance: Real analysis job followed by the document autoReframe command. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored moving subject center/known dimensions; recovered subject position transformed through the returned document; explicit framing bounds.

Unique failure protection: One complete analysis-to-command workflow now owns detection and resulting portrait framing, without reading output initialized by another test.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'follows the moving subject (saliency)'` | CONSOLIDATE | Both original cases survive in one analysis→portrait-command workflow; exact authored subject/framing oracles remain, with local analysis and one registration. |
| `'makes a 9:16 copy whose Position keeps the subject in frame'` | CONSOLIDATE | Both original cases survive in one analysis→portrait-command workflow; exact authored subject/framing oracles remain, with local analysis and one registration. |

### `apps/engine/test/gaps-routes.test.ts`

Independent source: Edit Original / Preferences contracts; S01 version policy; docs/wp-notes/gaps.md.

Stable seam and refactor resistance: Host opener OS command protocol and settings/location HTTP endpoints. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal OS CLI arguments (external protocol), authored registered paths, OPENER_MISSING and validation errors, persisted version/render optimization settings.

Unique failure protection: OS launch protocol, route failure translation and restart-applied preferences are different boundary failures; Windows security property tests own hostile Windows quoting separately.

Production owners inspected: `../src/routes/gaps.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'builds the host opener per platform'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'locates a registered file and opens it with the host opener'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reads, validates, persists and applies the version policy and render optimisation'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/imports.test.ts`

Independent source: docs/wp-notes/imports.md §§3/7; media protocol formats; AGENTS preview/export fidelity.

Stable seam and refactor resistance: ZIP/PSD/decode protocol boundaries, HTTP import endpoints and actual exported interpretation pixels. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored archives and format fixtures, independent Python ZIP consumer/producer, external FFmpeg/ffprobe, known frame-gap hashes and four literal premultiplied/ignored/inverted RGB expectations.

Unique failure protection: Import-only formats, gaps, layered metadata, display variants, Lottie packaging and alpha interpretation differ from plain media registration. The static alpha case keeps every oracle using one 64×36 frame per mode.

Production owners inspected: `../src/imports/decode.ts`, `../src/imports/psd.ts`, `../src/imports/zip.ts`, `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'round-trips stored archives and reads deflated entries'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'maps Photoshop aliases and falls back to normal for an unsupported mode'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'decodes EXR with the sRGB transfer and Radiance HDR through zscale'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'probes every imported format'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serves Lottie documents, SVG text and PDF pages'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'conforms an image sequence with a gap holding the previous frame'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'extracts PSD layers with blend modes, opacity, visibility and groups'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'makes display pictures of stills a browser cannot decode'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'exports a sequence with a still and a Lottie clip as Lottie'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'Interpret Footage ▸ Alpha Channel changes the native export (measured pixels)'` | OPTIMIZE | Four static alpha modes retain literal RGB vectors/tolerance with a uniform 64×36 source/sequence and one frame per export, replacing four default-duration 1080p exports. |

### `apps/engine/test/interchange.test.ts`

Independent source: Interchange public formats; docs/wp-notes/interchange.md; DATA-3.

Stable seam and refactor resistance: Interchange HTTP/jobs with actual files, media registration, extracted audio and relinking. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Explicit markers/placement data, format signatures, external decoded audio properties, original destination bytes and authored moved-media identities.

Unique failure protection: Format unit tests cannot detect job/filesystem/registration wiring, overwrite safety, embedded/separate media extraction or relinking. Different containers/modes have independently meaningful output contracts.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'exports FCP7 XML as a job and imports it back by path with the media registered'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'never overwrites an existing file at the destination (security review DATA-3)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'OMF with separate AIFF files broken out to mono, written next to the document'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'per-track EDLs and the pre-render plan'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses garbage with a named error'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/jobs.test.ts`

Independent source: S04 JB-010–040 and ENG-004; AGENTS worker/error safety.

Stable seam and refactor resistance: JobQueue job/event state, persisted journal and child processes; HTTP cancel/retry. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Explicit priority/slot order, dedupe ids, terminal/error codes, independent child-process liveness/file checks, original malformed journals and specified 4/s event upper bound.

Unique failure protection: Scheduling, retries, arbitrary runner rejection, throttling, actual process-tree cancellation, parent cascade, HTTP wiring and restart recovery fail independently. Virtual time preserves the rate cap without requiring a particular flush cadence.

Production owners inspected: `../src/events/broadcaster.ts`, `../src/jobs/queue.ts`, `../src/jobs/types.ts`, `../src/tools/ffmpeg.ts`, `../src/tools/process.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'runs lanes in priority order within the CPU slots and dedupes by key'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'starts exports with at least half the slots and pauses the background lane meanwhile (JB-012/013)'` | OPTIMIZE | The background runner records whether any export is still publicly running at its actual entry. This ordering oracle replaces a fixed100ms negative sleep and detects an illegal start regardless of deferred scheduling; real completion gates still prove the background job eventually starts. |
| `'fails with a retryable error, keeps a log, and retries as a new job'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'finishes jobs whose runner rejects with %j'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'throttles job.updated to 4/s per job and always sends the final state (JB-040)'` | OPTIMIZE | A controlled second of progress replaces real elapsed delays; verifies the independent at-most-four-progress-events/second cap plus forced running/final state, without pinning a 250 ms internal schedule; advancing further rejects stale post-terminal events. |
| `'cancels a running ffmpeg job within 5 s with no child process left and removes partials'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'cancels queued jobs immediately and cascades to child jobs'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'cancels over HTTP (POST /api/jobs/:id/cancel)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'does not restore malformed journal records as runnable jobs'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'marks a running job interrupted after a crash, restores queued jobs and re-queues artifact jobs'` | OPTIMIZE | One event-loop barrier replaces a fixed 100 ms sleep before the negative scheduling/requeue assertion; real completion/gating still establishes the positive outcome. |
| `'graceful shutdown records running jobs as interrupted (S04:ENG-004)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/lgpl-binaries.test.ts`

Independent source: ARCHITECTURE D-13; AGENTS §2; S04 ENG-011 and LC.

Stable seam and refactor resistance: Encoder selection/FFmpeg command protocol, binary/config resolution, license metadata and actual LGPL-only export/proxy. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal documented codec/container/encoder order and FFmpeg flags; authored BUILDINFO/license fixtures, external process success/failure and ffprobe artifact facts.

Unique failure protection: Configuration matrices deliberately cover hardware availability, explicit overrides, missing/partial/GPL binaries and legal notices without running every codec. Real LGPL-only export/proxy checks wiring that selector tables cannot; neither supersedes the other.

Production owners inspected: `../src/remotion/export-plan.ts`, `../src/remotion/service.ts`, `../src/tools/encoders.ts`, `../src/tools/ffmpeg.ts`, `../src/tools/lgpl.ts`, `../src/tools/licenses.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'prefers env → packaged resources → vendor'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'dev without a directory: Remotion bundled FFmpeg with the loud GPL warning'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'packaged (strict) without a directory refuses the Remotion path'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a configured but incomplete directory never silently falls back'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'uses .exe names on Windows'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'walks up to vendor/ffmpeg-lgpl/<platform> with a BUILDINFO.json'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'env → <resources>/bin → <resources>/ffmpeg-lgpl → vendor → PATH'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'strict without the LGPL directory: remotionLocal unavailable and renders refuse to start'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a directory with a GPL FFmpeg is refused in strict mode (license probe)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a bundled LGPL 3 build: SPDX id, exact source, build link, LGPL text and the GPL 3 text it refers to'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a bundled LGPL 2.1 source build has one license text and no prebuilt link'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a system ffmpeg, or a directory whose ffmpeg is not LGPL, is never presented as our bundled build'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the vendored directory (pnpm ffmpeg:lgpl) yields a complete entry'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'H.264 with the LGPL directory: ProRes intermediate, then our encoder (two phases)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'dev with GPL builds on both sides and libx264: Remotion encodes H.264 itself (unchanged)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'libx264 selected but Remotion uses the LGPL directory (no x264 there): intermediate'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'VP9 WebM + Opus goes direct through Remotion with mapped CRF and speed args'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'VP9 in MP4 (no Opus) or a Remotion build without libvpx-vp9: intermediate'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'no usable encoder: unavailable with LGPL (or LGPL-only), Remotion GPL H.264 only in plain dev'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/lgpl.test.ts`

Independent source: ARCHITECTURE D-13; AGENTS §2; S04 ENG-011 and LC.

Stable seam and refactor resistance: Encoder selection/FFmpeg command protocol, binary/config resolution, license metadata and actual LGPL-only export/proxy. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal documented codec/container/encoder order and FFmpeg flags; authored BUILDINFO/license fixtures, external process success/failure and ffprobe artifact facts.

Unique failure protection: Configuration matrices deliberately cover hardware availability, explicit overrides, missing/partial/GPL binaries and legal notices without running every codec. Real LGPL-only export/proxy checks wiring that selector tables cannot; neither supersedes the other.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'plans and runs a real native export with an LGPL-compatible encoder'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'makes proxies with an LGPL-compatible encoder (MP4)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/masks-track.test.ts`

Independent source: S09 TRK-010–014/020; docs/wp-notes/masks.md; geometric edge-regression contract.

Stable seam and refactor resistance: Tracking/decode HTTP/job or numerical geometry boundaries; actual mask alpha trace and document key application. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored motion/homography/occlusion fixtures, literal burnt-in frame codes, independent corner/centroid/edge truth and specified error/cancel tolerances.

Unique failure protection: Planar/point/mask models, directions, occlusion/EOF recovery, edge selection, exact seeking and mask-key/alpha-trace application are independently meaningful. Geometry here is rendering/tracking behavior, not incidental UI layout.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| ``${method}: follows the moving square forward (≤ 0.6 px)`` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'backward from the last frame; the document round trip writes Mask Path keys'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects a mask track without a polygon'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'traces the alpha of a still into a disc and a square with a hole'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/mcp.test.ts`

Independent source: ARCHITECTURE §11 / MCP Streamable HTTP protocol.

Stable seam and refactor resistance: Official MCP SDK client over an actual engine TCP listener. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: SDK handshake/session lifecycle, authored marker persisted in project data and literal HTTP auth/session errors.

Unique failure protection: Direct MCP tool tests cannot catch transport initialization, authorization, session ids, termination or HTTP-to-project application wiring.

Production owners inspected: `../src/index.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'serves the jasper-mcp tools to an SDK client with the engine token'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'requires the token and a known session'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/media.test.ts`

Independent source: S04 PB/TH/WF/PX/MS; ARCHITECTURE D-48 batch status.

Stable seam and refactor resistance: Media/status HTTP interfaces plus real generated derivatives and external decoders. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Known fixture metadata/rotation/duration, schema-defined sprite/peak wire formats, authored bytes for HTTP ranges/ETags, independent alpha samples and typed validation/errors.

Unique failure protection: Probe kinds, derivatives/proxy formats/alpha, range/cache/auth protocol and batching each have unique caller-visible failures. Unit probe mapping and sample reduction do not prove their real process/HTTP wiring.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'clip-a: 10 s 1080p30 H.264 + stereo AAC, browser playable'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'phone-rot90: display-matrix rotation 90, 5 s, stored landscape'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'still.png is an image without duration; tone.wav is audio'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'re-registering the same file returns the same key (dedupe by fingerprint) and bad paths error per file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'poster, sprite + index and peaks are produced and parseable'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'forces a 720p proxy for a non-browser-playable source'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'makes a VP9 WebM proxy that keeps the alpha channel of a ProRes 4444 overlay'` | OPTIMIZE | One FFmpeg RGBA decode supplies all three independent transparency/opacity samples, replacing three decoder startups; process status and byte count are additionally checked. |
| `'supports HEAD, single Range → 206, suffix ranges, 416, ETag/304 and If-Range'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects unknown or malformed keys, and reports derivatives that are not ready as 404'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serves signed URLs to cookie-less consumers in token mode (S04:MS-003) with CORS for the headless browser'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/node-runtime.test.ts`

Independent source: Security review RUN-1; packaged worker runtime/config resolution.

Stable seam and refactor resistance: nodeExecPath configuration result for real filesystem fixtures. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored explicit/bundled executable paths and process.execPath fallback, independently specified runtime precedence.

Unique failure protection: Packaged Electron must launch the shipped/configured Node worker rather than a second app; headless and missing override fallback differ from present bundle/override precedence.

Production owners inspected: `../src/tools/node-runtime.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'is this process in a checkout or a headless engine'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'is the runtime shipped in <resources>/node when there is one; JASPER_NODE wins'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/polish-media-status.test.ts`

Independent source: S04 PB/TH/WF/PX/MS; ARCHITECTURE D-48 batch status.

Stable seam and refactor resistance: Media/status HTTP interfaces plus real generated derivatives and external decoders. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Known fixture metadata/rotation/duration, schema-defined sprite/peak wire formats, authored bytes for HTTP ranges/ETags, independent alpha samples and typed validation/errors.

Unique failure protection: Probe kinds, derivatives/proxy formats/alpha, range/cache/auth protocol and batching each have unique caller-visible failures. Unit probe mapping and sample reduction do not prove their real process/HTTP wiring.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'returns registered status, lists unknown keys and removes duplicates'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'validates the body'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/processing-cli.test.ts`

Independent source: S07 processor cancellation; S04 JB-020; credible detached-child regression.

Stable seam and refactor resistance: Actual detached processor CLI and an executable external FFmpeg protocol fixture. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Readiness from processor progress, exit code 3, missing partial output and ESRCH for the child pid.

Unique failure protection: Generic queue cancellation cannot catch a processor that dies while its detached FFmpeg ignores SIGTERM and survives.

Production owners inspected: `../src/processing/proc-entry.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'cancels a processor whose detached FFmpeg ignores SIGTERM'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/processing-range.test.ts`

Independent source: S07 PRC-015/018/019; AGENTS data-loss safety.

Stable seam and refactor resistance: Actual processing/registration/export and media-discard HTTP endpoints. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Explicit source frames [12,48), literal burned-in frame codes, original/source file existence, authored source-range sidecar and deletion reason codes.

Unique failure protection: Ranged processing plus swap/back must preserve frames across offsets; metadata-only command tests cannot see wrong decoded source frames. Managed/user/derived/in-use refusal classes prevent distinct data loss.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'processes exactly the source frames [12, 48): result range, registry record, frame-exact content'` | CONSOLIDATE | One ranged processing→swap→swap-back workflow preserves every expected source frame; a shared decoder batches each increasing frame selection instead of launching FFmpeg once per sample. |
| `'a clip swapped onto the ranged version exports the same source frames on the native path, and back'` | CONSOLIDATE | One ranged processing→swap→swap-back workflow preserves every expected source frame; a shared decoder batches each increasing frame selection instead of launching FFmpeg once per sample. |
| `'reports the sidecar next to a file registered by path (trailer grade format)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'deletes only the managed copy and registry record when no project uses it'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `"never deletes the user's own files, processed versions or media a stored project uses"` | REWRITE | Registers its own coded media instead of depending on another test assigning codedMedia; derived/in-use/user-source refusal assertions remain. |

### `apps/engine/test/processing-remote-upload.test.ts`

Independent source: S07 PRM-001–009 / §8 remote acceptance; symlink-upload regression.

Stable seam and refactor resistance: SSH/SCP/rsync process protocol fixtures doing real local transfers and processor execution; optional real SSH. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Actual source/destination bytes, cache/job directories, process-group liveness and specified remote error codes. Shims isolate only transport; they execute real remote commands.

Unique failure protection: Probe/setup, cached execution, resume after partial upload, remote cancellation, connection-loss refusal and symlink dereference are independent protocol failures; none is simulated by a return-value mock.

Production owners inspected: `../src/processing/remote.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'uploads a symlink source as file bytes without leaving a partial file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/processing-remote.test.ts`

Independent source: S07 PRM-001–009 / §8 remote acceptance; symlink-upload regression.

Stable seam and refactor resistance: SSH/SCP/rsync process protocol fixtures doing real local transfers and processor execution; optional real SSH. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Actual source/destination bytes, cache/job directories, process-group liveness and specified remote error codes. Shims isolate only transport; they execute real remote commands.

Unique failure protection: Probe/setup, cached execution, resume after partial upload, remote cancellation, connection-loss refusal and symlink dereference are independent protocol failures; none is simulated by a return-value mock.

Production owners inspected: `../src/processing/remote.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'probe before setup reports the runtime is not installed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'setup installs an executable runtime that the probe reports ready'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'auto executor runs remotely; the input is cached by fingerprint; the job dir is removed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an interrupted upload retries to the exact source bytes without leaving a partial file'` | REWRITE | A transfer that has demonstrably written a partial must fail specifically with CANCELLED after abort; unrelated transport/setup failures no longer pass. The resumed final bytes and absence of partial files remain independently checked. |
| `'cancel kills the remote process group and leaves no job directory'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a broken connection fails with REMOTE_CONNECTION_LOST (retryable), never falls back to local'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'probe, setup, process, cleanup'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/processing-steps.test.ts`

Independent source: S07 PST and §8 acceptance matrix; AGENTS LGPL requirements.

Stable seam and refactor resistance: Real processor runtime/step boundary with independent decoded-frame/audio/geometry oracles. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored cadence/noise/block/gradient fixtures, external ffprobe/FFmpeg, bit-exact audio hashes, phase-correlation or column-profile motion metrics, explicit quality/zoom/count budgets; no renderer output is accepted merely because it exists.

Unique failure protection: Per-step conservation, quality, dejudder boundary context, no-cadence copying, smoothing caps/cuts/kernel equivalence and tiled-upscale blending have different failure modes. These legitimately expensive algorithm/format contracts remain in their required gate.

Production owners inspected: `../src/processing/proc/filters.ts`, `../src/processing/proc/runner.ts`, `../src/processing/proc/steps.ts`, `../src/processing/proc/upscale.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'rejects GPL-only filters and requires explicit approval for vidstab'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `name` | OPTIMIZE | The eight independently specified conservation cases reuse read-only source ffprobe facts and audio hash. Every output is still processed, decoded/hashed and checked separately (14 fewer source oracle processes). |
| `'vid.stab (WASM): motion variance drops ≥ 60 %'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'deshake: motion variance drops ≥ 40 %'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reduces uneven frame-to-frame motion by at least 50%'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'ranges starting mid-motion retime their edge frames like the whole file does'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'noise sigma of a flat patch drops ≥ 40 % (medium) with every method'` | OPTIMIZE | S07 §8.5 specifies noise reduction on a flat patch. Lossless cropping retains every byte of the original measured 440×200 patch plus 64 px context per side, beyond FFT block32 and nlmeans search15/patch7 support; all three real methods, frame windows and the ≥40% oracle remain. A source-noise floor rejects an empty fixture. Separate §8.2 owners retain the mandated full6s720p clip conservation checks. |
| `'deblock reduces 8x8 blockiness ≥ 25 %'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tiles are seamless on a gradient and mix blends linearly'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/processing.test.ts`

Independent source: S07 processing HTTP/config/catalog/derived-source contracts and §8.8.

Stable seam and refactor resistance: HTTP processing settings/models/jobs plus real processed media export. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal validation/install/capability/license data, registered derivation metadata, external probe/output bytes and successful export after the original source is deleted.

Unique failure protection: Configuration/discovery, missing preconditions, processed-version reuse and exporting with the original absent are distinct process/runtime wiring contracts.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'lists the model catalogue with install state'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'stores settings in engine.json and validates them'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'probe/setup without settings answer a clear "not configured" error'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports features.processing and licences (vid.stab, ONNX Runtime, OpenCV.js, weights)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects unknown media and uninstalled models'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'registers and reuses a processed version, then starts its browser proxy'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a sequence using a processed version plans native and exports reading the ProRes file (S07 §8 test 8)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/projects.test.ts`

Independent source: S01 persistence/lease/migration contracts; docs/project-files.md.

Stable seam and refactor resistance: ProjectStoreFs or real HTTP through EngineClient/EngineProjectStore, actual project/view/version/recovery files. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored names/revisions/view states, exact untouched byte snapshots, independent corrupt envelopes, specified lease/time limits and restored documents.

Unique failure protection: Ordinary save conflicts, session-client integration, malformed data preservation, schema backups, restore authorization, crash recovery and cross-process journal locks cover different failure stages; model migration tests cannot prove storage durability/coordinator behavior.

Production owners inspected: `../src/projects/leases.ts`, `../src/projects/store.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'creates, lists and opens a project envelope'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'saves with If-Match revisions and answers 409 with the current revision on conflict'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'works end to end with the session EngineProjectStore (open → save → conflict)'` | REWRITE | The second session must fail with LEASE_HELD; a network/parser or unrelated save error no longer satisfies the refusal assertion. Existing saved revision, conflict, view, lease release and deletion outcomes remain. |
| `'reports malformed saved views without changing project or view bytes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'opens projects with invalid view versions from disk and reports the reset'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps versions at most every 5 minutes of saving (S01:PER-020) and stores the view file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'grants one holder, refreshes by heartbeat, expires after 30 s and releases'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'takeOver revokes the other holder (WP-2E "Take over editing")'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/proposals-fuzz.test.ts`

Independent source: ARCHITECTURE D-51; S12 §2.5/2.8; docs/security-review AGT-2/3; AGENTS persistence.

Stable seam and refactor resistance: Proposal HTTP/WS/service/store/journal state and files; waiting events under controlled clocks. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal revisions/decisions/ids/error codes, unchanged project bytes, independently injected crash points and stored corrupt intents; journal result IDs now have an explicit protocol oracle, not idsWithBodies.

Unique failure protection: Dry-run/accept/reopen/policy/concurrency/retention/expiration/waiting/crash reconciliation are separate state-machine contracts. Store retention and intent evidence have lower owners; HTTP/session/crash tests uniquely protect their integration. Fuzz reaches seeded proposals that generic HTTP fuzz cannot.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'create'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'accept'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'decisions'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/proposals-journal.test.ts`

Independent source: ARCHITECTURE D-51; S12 §2.5/2.8; docs/security-review AGT-2/3; AGENTS persistence.

Stable seam and refactor resistance: Proposal HTTP/WS/service/store/journal state and files; waiting events under controlled clocks. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal revisions/decisions/ids/error codes, unchanged project bytes, independently injected crash points and stored corrupt intents; journal result IDs now have an explicit protocol oracle, not idsWithBodies.

Unique failure protection: Dry-run/accept/reopen/policy/concurrency/retention/expiration/waiting/crash reconciliation are separate state-machine contracts. Store retention and intent evidence have lower owners; HTTP/session/crash tests uniquely protect their integration. Fuzz reaches seeded proposals that generic HTTP fuzz cannot.

Production owners inspected: `../src/agent/service.ts`, `../src/proposals/journal.ts`, `../src/proposals/service.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'headless: the transaction was saved, the states were not → after a restart the items are accepted, never applied twice'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'headless: the engine stopped before the transaction → the intent is rolled back; the items apply once'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the editor applied the accept and disconnected before answering → pending while it is away, accepted once it is back'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the editor did not apply it and the window is gone (its lease expired) → rolled back from the saved project'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'creates nothing: the fingerprints of what it changes tell applied / not applied / changed since'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'creates something: its journalled ids decide, whatever prefix the live transaction gave them'` | REWRITE | Explicit expected mrk_/trk_ IDs replace an expected result calculated by the same production idsWithBodies helper used inside reconcileEvidence. The helper export is removed; its production use remains internal. |
| `'an unreadable intent file is moved aside with a warning; nothing crashes and nothing is recorded'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/proposals-store.test.ts`

Independent source: ARCHITECTURE D-51; S12 §2.5/2.8; docs/security-review AGT-2/3; AGENTS persistence.

Stable seam and refactor resistance: Proposal HTTP/WS/service/store/journal state and files; waiting events under controlled clocks. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal revisions/decisions/ids/error codes, unchanged project bytes, independently injected crash points and stored corrupt intents; journal result IDs now have an explicit protocol oracle, not idsWithBodies.

Unique failure protection: Dry-run/accept/reopen/policy/concurrency/retention/expiration/waiting/crash reconciliation are separate state-machine contracts. Store retention and intent evidence have lower owners; HTTP/session/crash tests uniquely protect their integration. Fuzz reaches seeded proposals that generic HTTP fuzz cannot.

Production owners inspected: `../src/proposals/store.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'round-trips proposals atomically (no temporary files left), newest first'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses to create a proposal for a project that does not exist (never creates its folder)'` | REWRITE | The absent project directory must report ENOENT, rather than any filesystem exception; PROJECT_NOT_FOUND and the empty public proposal listing remain checked. |
| `'evicts the oldest decided proposals at the limit and refuses (E_PROPOSAL_LIMIT) when all are undecided'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'expires proposals 30 days after their last change'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'never expires or evicts a proposal an accept or decision is working on (it does for that caller)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'moves unreadable files aside with a warning and never throws'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serializes concurrent writers per project (no lost proposal, limit respected)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/proposals-waiting.test.ts`

Independent source: ARCHITECTURE D-51; S12 §2.5/2.8; docs/security-review AGT-2/3; AGENTS persistence.

Stable seam and refactor resistance: Proposal HTTP/WS/service/store/journal state and files; waiting events under controlled clocks. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal revisions/decisions/ids/error codes, unchanged project bytes, independently injected crash points and stored corrupt intents; journal result IDs now have an explicit protocol oracle, not idsWithBodies.

Unique failure protection: Dry-run/accept/reopen/policy/concurrency/retention/expiration/waiting/crash reconciliation are separate state-machine contracts. Store retention and intent evidence have lower owners; HTTP/session/crash tests uniquely protect their integration. Fuzz reaches seeded proposals that generic HTTP fuzz cannot.

Production owners inspected: `../src/proposals/waiting.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'a poll every second is a wait from the first read; it ends 3.5 s after the last read'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reads far apart are not a poll; another agent starts over; forget is silent'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'follows a bounded number of proposals'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/proposals.test.ts`

Independent source: ARCHITECTURE D-51; S12 §2.5/2.8; docs/security-review AGT-2/3; AGENTS persistence.

Stable seam and refactor resistance: Proposal HTTP/WS/service/store/journal state and files; waiting events under controlled clocks. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal revisions/decisions/ids/error codes, unchanged project bytes, independently injected crash points and stored corrupt intents; journal result IDs now have an explicit protocol oracle, not idsWithBodies.

Unique failure protection: Dry-run/accept/reopen/policy/concurrency/retention/expiration/waiting/crash reconciliation are separate state-machine contracts. Store retention and intent evidence have lower owners; HTTP/session/crash tests uniquely protect their integration. Fuzz reaches seeded proposals that generic HTTP fuzz cannot.

Production owners inspected: `../src/events/broadcaster.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'creates a proposal validated against the live document; lists, gets, and publishes proposal.changed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'stores failing items invalid with the reason; refuses malformed drafts with typed errors'` | REWRITE | Retains state, typed code and structured stale-anchor data; removes assertions on incidental dependency/stale English wording. |
| `'accepts everything as ONE transaction (revision + 1, saved), records the decisions and refs'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'partial accept applies the rest and reports stale items; all-or-nothing refuses (409 PROPOSAL_STALE)'` | REWRITE | Retains state, typed code and structured stale-anchor data; removes assertions on incidental dependency/stale English wording. |
| `'expectedRevision: ahead → 409; behind with a conflicting edit → 409 REVISION_CONFLICT; behind otherwise fast-forwards'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reject, note, select (validated on the document), reopen and delete; each publishes proposal.changed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reopen of an applied item: agents are refused; the editor only once the accept is out of the document'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps at most 50 proposals: refuses while all are under review, then evicts the oldest decided one'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'deletes proposals with the project'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'concurrent accepts of the same items apply once; an accept racing an edit never loses either'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses an agent with 403 APPROVAL_REQUIRED unless the sequence allows agents; the editor needs nothing extra'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'applied (a Redo of an undone accept): the editor records it, an agent is refused, nothing is applied'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an agent polling a proposal (wait_for_proposal) is announced and listed as waiting; the editor and revalidating reads are not'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lets an agent accept where agentsMayApply is on; other features keep refusing'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'destructive items: an allowed agent still needs the approval card (headless → APPROVAL_DENIED); the editor does not'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `"live: accept goes to the open editor as ONE transaction; the editor's accept is the user's, an agent's waits for the card"` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/recovery-versions.test.ts`

Independent source: S01 persistence/lease/migration contracts; docs/project-files.md.

Stable seam and refactor resistance: ProjectStoreFs or real HTTP through EngineClient/EngineProjectStore, actual project/view/version/recovery files. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored names/revisions/view states, exact untouched byte snapshots, independent corrupt envelopes, specified lease/time limits and restored documents.

Unique failure protection: Ordinary save conflicts, session-client integration, malformed data preservation, schema backups, restore authorization, crash recovery and cross-process journal locks cover different failure stages; model migration tests cannot prove storage durability/coordinator behavior.

Production owners inspected: `../src/projects/leases.ts`, `../src/projects/recovery.ts`, `../src/projects/store.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'reports corrupt envelopes without changing the file or treating the project as missing'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lists healthy projects alongside a corrupt project without changing either file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'propagates project directory and file read errors'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps project (schema vN backup).jasper once, lists it and restores it as a copy'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'does not back up a save at the same schema'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'restores in place, keeping the replaced state, and only for the lease holder'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses malformed version envelopes without replacing or copying project data'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses unknown and path-like version ids'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'is held while the session holds the lease, then offered, read and discarded'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the session clears its own journal with its lease; a journal equal to the saved project is stale'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'journals unsaved edits, offers them after the editor dies, and restores saved versions'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'preserves unsaved snapshots when journal metadata is missing or malformed'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reads a valid journal when another session has incomplete metadata'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a journal written by another live engine process is never touched'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/remix-joints.test.ts`

Independent source: Historical audible-chop regression; S12 ending/EDGE contract; docs/wp-notes/sound-design.md.

Stable seam and refactor resistance: jointCrossfadesSeconds and blockMeanSquares numerical input/output boundary. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored RMS level changes and literal 110/30 ms choices, silence/out-of-range/non-finite samples.

Unique failure protection: Catches a continuing loud outgoing tail receiving a short crossfade, with matching/decaying/incoming-loud controls; general loudness tests cannot distinguish an audible remix joint.

Production owners inspected: `../src/audio/remix.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'110 ms where the source keeps sounding over what enters, 30 ms where it decays or matches'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'is total: silence, empty envelopes, cuts outside the signal'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/roto-core.test.ts`

Independent source: docs/wp-notes/roto.md §2; licensed numerical algorithm contracts; S04 child job safety.

Stable seam and refactor resistance: Pure maxflow/matting/segmentation numerical boundary and real segmentation job/PNG endpoints. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Brute-force minimum cut and distance, analytic alpha coverage/ellipse masks, external FFmpeg PNG decoding, specified cache/recompute spans and typed model/cancellation errors.

Unique failure protection: Arbitrary graph/cut correctness and alpha refinement exceed a single ellipse fixture; actual jobs add bidirectional propagation, cache correction, preview and cancellation/model wiring. Saved-reference extraction moved to real cache cleaning rather than a private field projection.

Production owners inspected: `../src/roto/core/matting.ts`, `../src/roto/core/maxflow.ts`, `../src/roto/core/segment.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'matches brute force on 400 random graphs and the labeling realises the cut'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'distance transform matches brute force'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'guided filter and closed-form matting recover a linear blend'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'segments the disk from a box alone'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'edge refinement softens the boundary towards the true coverage'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/roto.test.ts`

Independent source: docs/wp-notes/roto.md §2; licensed numerical algorithm contracts; S04 child job safety.

Stable seam and refactor resistance: Pure maxflow/matting/segmentation numerical boundary and real segmentation job/PNG endpoints. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Brute-force minimum cut and distance, analytic alpha coverage/ellipse masks, external FFmpeg PNG decoding, specified cache/recompute spans and typed model/cancellation errors.

Unique failure protection: Arbitrary graph/cut correctness and alpha refinement exceed a single ellipse fixture; actual jobs add bidirectional propagation, cache correction, preview and cancellation/model wiring. Saved-reference extraction moved to real cache cleaning rather than a private field projection.

Production owners inspected: `../src/cache/project-refs.ts`, `../src/processing/models.json`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'lists the vision models with licences and reports the capability'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'segments the base frame from a stroke and propagates both ways (IoU ≥ 0.95 on every frame)'` | CONSOLIDATE | One propagation→reuse→correction workflow retains analytic/external PNG oracles and recompute spans; no previous-test first result is read. |
| `'reuses every frame for the same inputs, and only recomputes after a correction'` | CONSOLIDATE | One propagation→reuse→correction workflow retains analytic/external PNG oracles and recompute spans; no previous-test first result is read. |
| `'computes a single frame for interactive previews'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'validates requests (400) and refuses faces without the face model (409)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'cancelling leaves no partial files and publishes no set'` | REWRITE | Creates its empty sets directory explicitly, so cancel assertions do not require a previous propagation test to have created it. |
| `'saved projects reference their roto sets (cache)'` | CONSOLIDATE | The private projection over an invalid miniature document is removed. The surviving owner in cache.test.ts stores a valid project through commands, keeps its matte during real GC, clears the result and then verifies release. |
| `'installs the model through the catalogue installer and segments with it'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/route-client-gone.test.ts`

Independent source: Credible request.close vs response.close regression; S12 long-route cancellation; S04 failure safety.

Stable seam and refactor resistance: Real HTTP sockets and each route's passed cancellation signal. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: A held external work dependency records signal state while the request remains connected and after the client socket closes; it does not implement the route's signal creation.

Unique failure protection: Each route calls the shared signal helper at a different await boundary; helper unit tests cannot catch a route attaching too late or passing no signal. Event-loop completion replaces 200 ms delays and disconnect follows actual worker entry.

Production owners inspected: `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| ``${r.name}: answered while the client waits (the work's signal is not aborted)`` | OPTIMIZE | All five routes retain both connected and disconnected real-socket checks. setImmediate crosses an event-loop turn instead of waiting 200 ms; disconnect occurs after actual work entry instead of sleeping 50 ms. |
| ``${r.name}: cancelled when the client closes the connection`` | OPTIMIZE | All five routes retain both connected and disconnected real-socket checks. setImmediate crosses an event-loop turn instead of waiting 200 ms; disconnect occurs after actual work entry instead of sleeping 50 ms. |

### `apps/engine/test/security-hardening.test.ts`

Independent source: docs/security-review.md findings ENG/DATA/ZIP/SSH and AGT/DEV/MG/RUN; ARCHITECTURE D-47.

Stable seam and refactor resistance: HTTP/WS authorization/capability/resource boundaries, actual OS/tool behavior and filesystem artifacts. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Explicit stable denial/error codes, original confidential bytes, independently recording peers/servers, exact CSP/wire bytes where security-relevant, resource/retention bounds and original OS errors.

Unique failure protection: Tests intentionally isolate different trust boundaries/attacks: token vs editor attestation, per-card keys, destructive route approval, pairing and secret exclusion, sandbox scope, path traversal/SSRF, license/download caps, filter escaping, size/ZIP bounds and command injection. Generic success routes cannot supersede these failures.

Production owners inspected: `../src/agent/index.ts`, `../src/auth/signed-url.ts`, `../src/context.ts`, `../src/index.ts`, `../src/routes/mg-bundles.ts`, `../src/server.ts`, `../src/tools/services.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'classifies a request by the editor key cookie, never by the token'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tells an /agent connection whether it is the editor'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a token-holding connection gets no card and can neither approve nor deny, even with the approval id'` | OPTIMIZE | WebSocket ping/pong barriers confirm preceding messages were handled instead of 3×60 ms sleeps; spoofed approval messages must still leave real cards pending. |
| `'the editor must present the key of that card: none, another card’s or another window’s do not count'` | OPTIMIZE | WebSocket ping/pong barriers confirm preceding messages were handled instead of 3×60 ms sleeps; spoofed approval messages must still leave real cards pending. |
| `'without an editor window the request is refused at once, whoever else is connected'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a window that opens the project while a request is pending is shown the card, with its own key'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an approved request is relayed to the editor as approved; the answer came from a real card'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an agent cannot delete a preset of the user’s library: refused without an editor, asked with one'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the editor window deletes without a card, unless it acts on an agent’s live-UI input'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'deleting a preset bin says what is inside; a missing preset is a 404, not a card'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an approval names the agent from its header, bounded and without control characters'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses an agent that wants to $name while no editor window is open'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'what the automatic cleaning does itself needs no approval: clean unused, delete named render segments'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an agent may fill and delete a project it created; once the user has saved it, it asks'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'an agent cannot take a project away from the window that is editing it'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'removing a downloaded model asks the user (speech and roto catalogues)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a dev engine started without a token makes one, requires it, and tells local tools where it is'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'every start has a new token; a token given by whoever starts the engine is used as is'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the editor key is never in the runtime file, the health answer or the engine’s output'` | REWRITE | The production editor-key file must be absent with ENOENT; another filesystem exception cannot mask key material on disk. Runtime, health, MCP/capability answers and captured logs must still exclude the literal secret. |
| `'a dev engine keeps its editor key in a 0600 file next to the runtime file and reuses it'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'JASPER_INSECURE_DEV=1 is the only way to listen without a token, and it says so loudly'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'pairing: the link of an engine that serves the web app makes a browser the editor; nothing else does'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the host page redirects to a capability path; its policy sandboxes the document and scopes what it loads'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the capability is per bundle, read-only, and nothing outside the bundle is reachable through it'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'under the address the editor knows, bundle files are inert data: no script runs with the editor’s origin'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'mgHostCsp never widens: no ancestors means nobody may frame the page'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/security-review.test.ts`

Independent source: docs/security-review.md findings ENG/DATA/ZIP/SSH and AGT/DEV/MG/RUN; ARCHITECTURE D-47.

Stable seam and refactor resistance: HTTP/WS authorization/capability/resource boundaries, actual OS/tool behavior and filesystem artifacts. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Explicit stable denial/error codes, original confidential bytes, independently recording peers/servers, exact CSP/wire bytes where security-relevant, resource/retention bounds and original OS errors.

Unique failure protection: Tests intentionally isolate different trust boundaries/attacks: token vs editor attestation, per-card keys, destructive route approval, pairing and secret exclusion, sandbox scope, path traversal/SSRF, license/download caps, filter escaping, size/ZIP bounds and command injection. Generic success routes cannot supersede these failures.

Production owners inspected: `../src/color/extension.ts`, `../src/color/ocio-bundle.ts`, `../src/export/planner.ts`, `../src/imports/lottie.ts`, `../src/mg-bundles/zip.ts`, `../src/processing/models.ts`, `../src/processing/settings.ts`, `../src/speech/models.ts`, `../src/tools/ffmpeg.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'an imported SVG is served sandboxed and nosniff'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'processing models'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'speech (and roto) models'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lut3d loads %s'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'never copies other files (absolute paths, ../, non-LUT content) into the bundle'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a non-image "image" asset is left empty (with a warning), a real PNG is embedded'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'recovery routes cannot leave the project folder (no rm -rf of <elsewhere>/recovery/<name>)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'media jobs refuse a project id that is not one'` | OPTIMIZE | Removes a 300 ms sleep after the request already returned VALIDATION_FAILED before job submission; the outside directory must remain absent. |
| `'only media and document files are opened; programs, launchers and extensionless files are refused'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses a foreign Origin and a foreign Host (a web page cannot attach as an editor session)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'needs the token in token mode'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'assertFrameSize'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a gigantic export size is refused; a gigantic sequence in a hostile document is clamped on load'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'extracts a deflated entry and refuses one whose data outgrows its declared size'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a large entry is not held in memory (128 MiB entry, peak buffers under 64 MiB)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses a user name that ssh would read as an option'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/server.test.ts`

Independent source: S04 ENG-003/004/010/020/022/024 and SC-001; security-review DEV-1.

Stable seam and refactor resistance: Actual Fastify HTTP/startEngine/config/filesystem boundary. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Literal public status/error/header/route contracts, authored SPA/static bytes, bind denial, runtime metadata/mode/removal and startup scratch contents.

Unique failure protection: Server-only Host/Origin/auth/API/fallback/runtime lifecycle behavior is distinct from agent WebSocket checks and individual service tests.

Production owners inspected: `../src/index.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'GET /health returns ok with the API header'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects foreign Host headers (DNS-rebinding defense)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'local token mode requires the bearer token or session cookie, except /health'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'serves the SPA with a fallback that never shadows engine paths'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'uses the ENG-022 error shape for bad requests and unknown routes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects cross-origin requests (same-origin only, S04:SC-001)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses a non-loopback bind without a token (M1 is loopback only)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'writes <appdir>/engine/runtime.json (0600) for local tools and removes it on stop'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'wipes tmp/ but keeps .gitkeep'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/smoothpath.test.ts`

Independent source: S07 PST and §8 acceptance matrix; AGENTS LGPL requirements.

Stable seam and refactor resistance: Real processor runtime/step boundary with independent decoded-frame/audio/geometry oracles. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored cadence/noise/block/gradient fixtures, external ffprobe/FFmpeg, bit-exact audio hashes, phase-correlation or column-profile motion metrics, explicit quality/zoom/count budgets; no renderer output is accepted merely because it exists.

Unique failure protection: Per-step conservation, quality, dejudder boundary context, no-cadence copying, smoothing caps/cuts/kernel equivalence and tiled-upscale blending have different failure modes. These legitimately expensive algorithm/format contracts remain in their required gate.

Production owners inspected: `../src/processing/proc/runner.ts`, `../src/processing/proc/smoothpath/math.ts`, `../src/processing/proc/steps.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'tracks the background (not the subject), evens out the reframe within the zoom cap'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports fallback and releases locks when the cap is too small'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'warps the same with the vid.stab WASM kernel and the OpenCV.js fallback'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/speech-core.test.ts`

Independent source: docs/wp-notes/speech.md §§2–4/7; licenses/ported/speech*.md; S04 TR/JB.

Stable seam and refactor resistance: Whisper numerical/token protocol, model HTTP/install/worker lifecycle and optional real recognizer. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Independent DFT, literal Slaney/timestamp vectors, authored speech/silence/formant fixtures, pinned token vocabulary, public-domain transcript and measured utterance timings; verified file checksums/errors.

Unique failure protection: The core owns model input/output protocol, VAD/diarization/alignment logic; route tests own catalog/install/refusals/worker failure; optional real model tests uniquely prove WER, timing, language and sequence-time recognition across windows.

Production owners inspected: `../src/speech/core/align.ts`, `../src/speech/core/decode.ts`, `../src/speech/core/diarize.ts`, `../src/speech/core/mel.ts`, `../src/speech/core/tokenizer.ts`, `../src/speech/core/vad.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'filterbank shape and coverage; Slaney scale'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a tone lands in its band'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the 400-point Whisper FFT equals a direct DFT over 201 bins'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'silence is trimmed from words'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'threshold: 30 % from floor to speech, at least 6 dB above the floor; digital silence ignored'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a word keeps at least 60 ms and unvoiced words are left alone'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'extends early-ending / late-starting words into the voice beside a pause, never into a neighbour'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'repairs a word straddling a pause and moves a word found in silence onto unassigned voice'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'endOfVoice stops at the first silent frame or the limit'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'two synthetic voices are told apart'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'one voice is one speaker'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'chunks split at pauses and join short ones'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a speaker-count hint forces exactly that many speakers'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'alignTokens finds where each token attends'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'word timings, punctuation merging and segment distribution'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reads specials, languages and bytes'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'timestamp rules: first token a timestamp ≤ max initial, monotonic, pairs'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'segments and seek'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'repetition guard, compression ratio, seeded sampling'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/speech-model.e2e.test.ts`

Independent source: docs/wp-notes/speech.md §§2–4/7; licenses/ported/speech*.md; S04 TR/JB.

Stable seam and refactor resistance: Whisper numerical/token protocol, model HTTP/install/worker lifecycle and optional real recognizer. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Independent DFT, literal Slaney/timestamp vectors, authored speech/silence/formant fixtures, pinned token vocabulary, public-domain transcript and measured utterance timings; verified file checksums/errors.

Unique failure protection: The core owns model input/output protocol, VAD/diarization/alignment logic; route tests own catalog/install/refusals/worker failure; optional real model tests uniquely prove WER, timing, language and sequence-time recognition across windows.

Production owners inspected: `../src/processing/models.ts`, `../src/speech/models.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'lists the installed models and reports the capability'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'transcribes the media (English model): WER ≤ 4 %, word bounds within 60 ms on average'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'detects the language with the multilingual model and labels a single reader as one speaker'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'transcribes a trimmed and offset sequence mix in sequence time'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'cancels a running transcription (the child process is killed)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/speech.test.ts`

Independent source: docs/wp-notes/speech.md §§2–4/7; licenses/ported/speech*.md; S04 TR/JB.

Stable seam and refactor resistance: Whisper numerical/token protocol, model HTTP/install/worker lifecycle and optional real recognizer. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Independent DFT, literal Slaney/timestamp vectors, authored speech/silence/formant fixtures, pinned token vocabulary, public-domain transcript and measured utterance timings; verified file checksums/errors.

Unique failure protection: The core owns model input/output protocol, VAD/diarization/alignment logic; route tests own catalog/install/refusals/worker failure; optional real model tests uniquely prove WER, timing, language and sequence-time recognition across windows.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'lists the models with licence, size and install state'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses to transcribe with a model that is not downloaded (409), an unknown model (404) or media (404)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'installs a multi-file model through the model-download job, verified file by file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a file whose sha256 does not match fails the install and leaves no partial file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'English-only models refuse translation and other languages'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a model that cannot be loaded fails the transcription job with the worker message'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lists the speech weights in the licences and deletes a model'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/sync-audio.test.ts`

Independent source: Audio Sync public contract; docs/wp-notes/gaps.md and audio-mix.md.

Stable seam and refactor resistance: Actual sync HTTP endpoint, FFmpeg decoding and GCC-PHAT result. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored recording offsets/polarity/noise and unrelated source, sample-exact PCM and 1 ms AAC tolerances, independently selected clip ranges/maxOffset.

Unique failure protection: DSP-only delay tests cannot prove encoded media decoding, stream selection or mapping timeline ranges back into media time; validation covers separate HTTP preconditions.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'finds each recording’s offset against the reference, sample-accurate for PCM and within 1 ms through AAC'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'analyses a stretch of each recording (timeline clips: sourceIn / duration) and honours maxOffset'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'validates requests'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/three-d-models.test.ts`

Independent source: docs/wp-notes/three-d.md model media support; glTF/OBJ format contracts.

Stable seam and refactor resistance: Media registration HTTP for authored OBJ/glTF/invalid GLB bytes. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Known triangle data and literal model/container classification; invalid binary glTF refusal leaves no registered item.

Unique failure protection: Project glTF parsers alone cannot catch a registration route failing to classify/retain model media or swallowing a readable failure.

Production owners inspected: .

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'registers an OBJ and a glTF as kind model'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses a model it cannot read, with the reason'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/tracking-unit.test.ts`

Independent source: S09 TRK-010–014/020; docs/wp-notes/masks.md; geometric edge-regression contract.

Stable seam and refactor resistance: Tracking/decode HTTP/job or numerical geometry boundaries; actual mask alpha trace and document key application. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored motion/homography/occlusion fixtures, literal burnt-in frame codes, independent corner/centroid/edge truth and specified error/cancel tolerances.

Unique failure protection: Planar/point/mask models, directions, occlusion/EOF recovery, edge selection, exact seeking and mask-key/alpha-trace application are independently meaningful. Geometry here is rendering/tracking behavior, not incidental UI layout.

Production owners inspected: `../src/tracking/geometry.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'snaps to the edge nearest to the given side, never across the bezel (wall → bezel → mask → screen)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'keeps the predicted line for sides outside the frame and rejects far edges'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/tracking.test.ts`

Independent source: S09 TRK-010–014/020; docs/wp-notes/masks.md; geometric edge-regression contract.

Stable seam and refactor resistance: Tracking/decode HTTP/job or numerical geometry boundaries; actual mask alpha trace and document key application. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored motion/homography/occlusion fixtures, literal burnt-in frame codes, independent corner/centroid/edge truth and specified error/cancel tolerances.

Unique failure protection: Planar/point/mask models, directions, occlusion/EOF recovery, edge selection, exact seeking and mask-key/alpha-trace application are independently meaningful. Geometry here is rendering/tracking behavior, not incidental UI layout.

Production owners inspected: `../src/tools/ffmpeg.ts`, `../src/tools/services.ts`, `../src/tracking/decode.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'answers 404 ASSET_NOT_FOUND for an unknown media key'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'answers 400 VALIDATION_FAILED for bad bodies and geometry'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lands on the exact frames after an input seek (system ffmpeg)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'lands on the exact frames with the LGPL ffmpeg build'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tracks the plate both ways from a mid reference within 1.5 px RMS, 4 px max, with live progress'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tracks forward only (span = reference … end) and pads frames past the end of the media as lost'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tracks backward with the surroundings ring (span = start … reference)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'tracks the blob both ways within 1 px RMS'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'stops a running track job within 500 ms'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/unit.test.ts`

Independent source: S01 AST-003; S04 MS-003/ENG-022/023/WF/PB; config ENV contracts.

Stable seam and refactor resistance: Fingerprint files, URL signer, event replay, streamed PCM reducer, probe entry point and HTTP system error translation. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Python hashlib pins, tampered paths/expiry, explicit bounded replay ids, authored PCM peaks, captured ffprobe-shaped inputs and typed/path-redacted HTTP errors.

Unique failure protection: These lower seams cover content-addressed compatibility, cryptographic integrity, overflow replay, chunk-split sample handling and malformed external data; integration success alone would miss their adversarial inputs.

Production owners inspected: `../src/auth/signed-url.ts`, `../src/derivatives/peaks.ts`, `../src/events/broadcaster.ts`, `../src/media/fingerprint.ts`, `../src/media/probe.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| ``${name}: file agrees with the vector`` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'media keys are mk_ + 24 hex of the fingerprint'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'verifies path + expiry and rejects tampering'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports incomplete replay when the bounded event buffer overflows'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'computes max-abs per channel and per window across chunk boundaries'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reads legacy rotation tags when the display matrix is absent'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'detects VFR and VP9 alpha metadata'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'maps ENOSPC to DISK_FULL, ENOENT to NOT_FOUND and other fs errors to INTERNAL without paths'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the dev engine accepts the Vite host given by JASPER_DEV_WEB_PORT (default 5173)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'resolves a relative JASPER_WEB_DIR against the working directory (@fastify/static needs an absolute root)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/uploads.test.ts`

Independent source: S04 IN-005/SC-005; AGENTS visible failure/data-loss rules.

Stable seam and refactor resistance: Chunked upload HTTP and UploadService files/expiry/error callback. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Original fixture bytes, explicit expected offsets/size/refusal codes, stored file absence, actual ENOTDIR and controlled 24-hour expiry.

Unique failure protection: Offsets/resume, abort, missing data, background sweep errors and disk/idle-session bounds are different corruption/leak paths not exercised by path-based registration.

Production owners inspected: `../src/tools/services.ts`, `../src/uploads/service.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'uploads clip-b in 3 chunks, rejects a wrong offset with the expected one, and registers the media'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'aborts an upload session'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses to recreate missing upload data as an empty file'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'reports a background sweep filesystem failure without crashing'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'checks free disk space (DISK_FULL) and expires idle sessions after 24 h (S04:SC-005)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/vidstab-wasm.test.ts`

Independent source: S07 full-depth stabilization; manifest-pinned LGPL vid.stab kernel contract.

Stable seam and refactor resistance: Actual WASM worker pool on authored uint16 RGB pixels. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Analytic integer translation with independent channel/row/color values across worker bands.

Unique failure protection: Catches axis sign, channel swaps, 8-bit truncation and band-edge corruption that approximate motion quality tests can miss.

Production owners inspected: `../src/processing/proc/vidstab/pool.ts`, `../src/processing/proc/vidstab/wasm.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'moves full-depth RGB pixels by an integer camera translation across worker bands'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/windows-opener.test.ts`

Independent source: docs/security-review WIN-1/ENG-5; OS Windows command-line protocols.

Stable seam and refactor resistance: Actual openerFor protocol bytes interpreted by independent libuv/explorer models; optional real PowerShell recording opener. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Authored adversarial paths, fixed safe command line/environment, an independent parser and actual recorded process arguments/no executed side effects.

Unique failure protection: Windows metacharacter parsing differs from Unix argument arrays; constant command/environment, explorer comma grouping, illegal-name refusal and real PowerShell execution each protect a separate parser boundary.

Production owners inspected: `../src/routes/gaps.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'never cmd.exe, never a shell, whatever the path (property)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'any path without a double quote parses back to itself (property)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'%s'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'%j'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'a missing file is an error from PowerShell, not an open of something else'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

### `apps/engine/test/worker-pools.test.ts`

Independent source: AGENTS child/worker failures become settled job errors; S04 ENG-002/JB; historical tsx worker hang.

Stable seam and refactor resistance: Actual Worker threads/ExportWorkerPool completion/error and a spawned tsx engine path. Assertions concern semantic output/protocol/files rather than private call count or markup.

Independent oracle: Settled/rejected promises with explicit error reason, real worker exit, valid allocation bounds and successful tsx subprocess completion.

Unique failure protection: Close, mid-flight exit, startup failure, unclonable input and allocation refusal fail at different lifecycle stages; the real tsx case catches dev-only worker boot bugs that Vitest transforms mask.

Production owners inspected: `../src/export/worker-pool.ts`.

| Original test declaration / target (all generated cases) | Outcome | Reason / surviving owner |
|---|---|---|
| `'closing settles both running and queued requests'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'the blend pool works in the dev engine (tsx, esbuild keepNames)'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'refuses invalid worker counts before allocating workers: %s'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'bounds worker and frame-slot allocation'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'terminates already-created workers if startup fails'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects running and queued tasks when a worker exits'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |
| `'rejects unclonable messages without leaving a request pending'` | KEEP | The named behavior supplies a distinct failure in this file's contract profile; its authored/third-party oracle is independent of the implementation, it observes the stable boundary listed above, and no remaining lower owner proves that boundary failure. |

## Added surviving owner

`apps/engine/test/cache.test.ts` — `keeps the matte set of a saved roto and removes it after its result is cleared`: CONSOLIDATE. Source: S04 CA-012 and roto work-note §2. A valid project built with real commands stores a result key; real cache cleaning keeps that authored file while removing an unrelated set, then removes it after clearing the persisted result. This catches missing roto references in the actual GC path. Filesystem state is the independent oracle; the CacheService/persisted-project seam survives index refactors and is not covered by the old private projection.

## Validation and performance

Pending controlled runs after the root baseline completes. This report does not claim a measured speedup or that skipped optional model/SSH/PowerShell/vendor suites passed. Root suite timings and detailed runner expansion are reported by the integration audit.
