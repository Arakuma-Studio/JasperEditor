# Engine rendering test cleanup — pre-edit disposition ledger

Recorded before editing after remote merge `87ebec9`. Scope excludes `mg-bundles.test.ts` (engine parent owns it). No repository AGENTS.md exists; host agent-browser rule honored. Commands: engine `vitest run`, root `pnpm lint`, `pnpm typecheck`, `pnpm test`.

For every KEEP/REWRITE below, the six numbered statements are the retention bar. Source and seam are specific to the containing file. Storage/config/security exceptions apply where named; there is no exemption for implementation shape. E2E output artifacts remain under the temporary engine renders directory (shape/color tests also save PNGs); bake suites retain measurement logs in `/tmp/layer-bake*.txt`.

Isolated failure inventory: page pool can overallocate pages, overrun the in-flight limit, scramble result order, misaggregate visible progress, drop the first error, start work after failure, or leak work after cancellation. Bake cache can collide between different render inputs, miss valid reuse, evict live files, retain expired files, or serve wrong/unsafe frame paths. These are the reasons their focused tests survive.

## apps/engine/test/anime.test.ts
Independent source: S11 ANM-011, FIX-009, acceptance license notice. Owner read: `src/anime/index.ts, src/routes/anime.ts, src/remotion/service.ts`. Non-test callers: routes/anime.ts and LayerBakeService consume license/version and Remotion bundle identity.

### KEEP: the pinned version matches packages/motion and the installed package
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 ANM-011, FIX-009, acceptance license notice; exact protected behavior: the pinned version matches packages/motion and the installed package.
2. Caller-visible failure: A dependency upgrade bypasses the required determinism review or ships a different MIT notice.
3. Oracle: Fixed 4.5.0 pin and byte equality against the installed upstream LICENSE; this is config/legal data, not a source-identifier grep.
4. Stable seam: manifest/license bytes; HTTP licensing/capability; source-bundle storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only manifest/install/notice consistency check; HTTP license tests cannot detect a package pin drifting while old fallback text still serves.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime.test.ts --maxWorkers=1`.

### REWRITE: lists anime.js (MIT, with its text) in /api/licenses and fills features.anime
Retain HTTP MIT notice/version and capability contract; remove direct helper duplicate and expected catalogue counts computed with precisely the same registry expressions as production.
1. Independent requirement: S11 ANM-011, FIX-009, acceptance license notice; exact protected behavior: lists anime.js (MIT, with its text) in /api/licenses and fills features.anime.
2. Caller-visible failure: About/Licenses omits or mislabels the bundled animation dependency, or capability discovery omits its version.
3. Oracle: Exactly one animejs license entry, fixed MIT/version/bundled state and attribution; capability version plus API schema.
4. Stable seam: manifest/license bytes; HTTP licensing/capability; source-bundle storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only public registration test; the fallback helper test cannot detect the route plugin failing to register.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime.test.ts --maxWorkers=1`.

### REWRITE: packaged-like: without the installed package, the committed licence text and the pinned version
The packaged fallback MIT notice/version is a distribution contract. Replace expected text read from the identical production fallback file with independently fixed license attribution and MIT grant.
1. Independent requirement: S11 ANM-011, FIX-009, acceptance license notice; exact protected behavior: packaged-like: without the installed package, the committed licence text and the pinned version.
2. Caller-visible failure: Packaged users receive no animation license notice because node_modules is absent.
3. Oracle: Fixed MIT grant, author attribution, version and bundled status with no installed package.
4. Stable seam: manifest/license bytes; HTTP licensing/capability; source-bundle storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Dev HTTP route resolves the installed package and cannot exercise missing-package distribution fallback.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime.test.ts --maxWorkers=1`.

### KEEP: changes with the lockfile and with the sources of every bundled workspace package
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 ANM-011, FIX-009, acceptance license notice; exact protected behavior: changes with the lockfile and with the sources of every bundled workspace package.
2. Caller-visible failure: Renderer serves stale composition code after a dependency/lockfile update.
3. Oracle: Same files imply same identity; independently changing each bundled source or lockfile must change identity.
4. Stable seam: manifest/license bytes; HTTP licensing/capability; source-bundle storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: The only cache-invalidation check across workspace inputs; render-key tests receive bundleId as data and cannot detect omitted hash inputs.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime.test.ts --maxWorkers=1`.

## apps/engine/test/anime-scaffold.test.ts
Independent source: S11 ANM-016/002. Owner read: `src/mg-bundles/scaffold.ts and template/files.ts`. Non-test callers: scaffoldProject is called by engine CLI; generated composition imports timeline module.

### KEEP: the scaffolded project compiles (esbuild bundle of src/index.ts with the workspace packages)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 ANM-016/002; exact protected behavior: the scaffolded project compiles (esbuild bundle of src/index.ts with the workspace packages).
2. Caller-visible failure: A newly generated user project cannot compile because generated imports/code are broken.
3. Oracle: Real esbuild succeeds and emits a nonempty bundle from scaffoldProject output.
4. Stable seam: generated project compilation and shipped timeline module.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Compilation of generated files differs from repository typechecking; template source strings are outside normal TS compilation.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-scaffold.test.ts --maxWorkers=1`.

### REWRITE: the example timeline is order-independent (bundled with the pinned anime.js)
ANM-016/002 promises deterministic seeks, not particular decorative coordinates. Remove hardcoded y/rotation values; retain nonconstant timeline and reversed/random visit-order equivalence.
1. Independent requirement: S11 ANM-016/002; exact protected behavior: the example timeline is order-independent (bundled with the pinned anime.js).
2. Caller-visible failure: Scrubbing a scaffolded animation backward changes its frame depending on prior visits.
3. Oracle: A nonconstant timeline gives identical per-frame values for fresh builds and reverse/shuffled visits.
4. Stable seam: generated project compilation and shipped timeline module.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: The scaffold ships its own timeline example; motion runtime determinism tests never execute those generated source bytes.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-scaffold.test.ts --maxWorkers=1`.

## apps/engine/test/anime-templates.test.ts
Independent source: S11 ATP-008/010 and FIX-008. Owner read: `src/routes/mg.ts, mg/service.ts, export/planner.ts and export/service.ts`. Non-test callers: routes call MG registry validation and export planner; missingTemplates is used by export/still owners.

### KEEP: lists anime templates with renderer anime and native false
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 ATP-008/010 and FIX-008; exact protected behavior: lists anime templates with renderer anime and native false.
2. Caller-visible failure: Clients offer an anime template to the incompatible fframes renderer.
3. Oracle: title-reveal has fixed renderer anime and native false in the HTTP catalog.
4. Stable seam: HTTP catalog/render/export/still APIs and range-planner snapshot.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only catalog classification contract; route refusal is a different operation.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-templates.test.ts --maxWorkers=1`.

### REWRITE: the render route refuses anime templates whatever the fframes state (400 ANIME_TEMPLATE)
ATP-008 requires HTTP 400 ANIME_TEMPLATE, not sentence wording. Remove exact-message fragment.
1. Independent requirement: S11 ATP-008/010 and FIX-008; exact protected behavior: the render route refuses anime templates whatever the fframes state (400 ANIME_TEMPLATE).
2. Caller-visible failure: An anime render request reaches fframes or returns misleading unavailable-renderer status.
3. Oracle: HTTP 400 and ANIME_TEMPLATE even with fframes unavailable.
4. Stable seam: HTTP catalog/render/export/still APIs and range-planner snapshot.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only precedence check for this render endpoint; project/template model tests do not execute HTTP routing.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-templates.test.ts --maxWorkers=1`.

### KEEP: only clips inside the exported range count
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 ATP-008/010 and FIX-008; exact protected behavior: only clips inside the exported range count.
2. Caller-visible failure: A missing template outside the requested still range prevents rendering an otherwise valid frame.
3. Oracle: An explicitly out-of-range missing template yields no missingTemplates errors after planning the still.
4. Stable seam: HTTP catalog/render/export/still APIs and range-planner snapshot.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: The negative counterpart to in-range HTTP failures; those failures cannot catch overly broad validation.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-templates.test.ts --maxWorkers=1`.

### REWRITE: POST /api/exports and /api/exports/plan answer 409; a still job fails with the same code
ATP-010/FIX-008 requires TEMPLATE_NOT_INSTALLED on all export entry points, not prose. Keep status and error code; remove message substring.
1. Independent requirement: S11 ATP-008/010 and FIX-008; exact protected behavior: POST /api/exports and /api/exports/plan answer 409; a still job fails with the same code.
2. Caller-visible failure: An unavailable template silently renders blank or only one export entry point refuses it.
3. Oracle: Each export endpoint returns 409/TEMPLATE_NOT_INSTALLED; accepted still job fails with the same code.
4. Stable seam: HTTP catalog/render/export/still APIs and range-planner snapshot.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only per-entry-point missing-template enforcement; pure range test does not execute service guards.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/anime-templates.test.ts --maxWorkers=1`.

## apps/engine/test/page-pool.test.ts
Independent source: S11 LBK-022; wp-m2-layer-bake Parallel bakes design. Owner read: `src/remotion/page-pool.ts`. Non-test callers: layer-bake/extension.ts and mg-bundles/service.ts both call runPagePool.

### KEEP: never grants more pages than the render budget
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes design; exact protected behavior: never grants more pages than the render budget.
2. Caller-visible failure: Concurrent renders overallocate browser pages or deliver results to the wrong input clip.
3. Oracle: Sum of granted pages never exceeds fixed budget 6; completed results retain independently assigned input order.
4. Stable seam: task scheduler caller contract (resource grants, ordered results, progress and abort).
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Both bake and MG callers use this scheduler; renderer E2E cannot deterministically measure each allocation transition.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/page-pool.test.ts --maxWorkers=1`.

### KEEP: bounds the renders in flight; maxInFlight 1 runs them one after the other with the whole budget
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes design; exact protected behavior: bounds the renders in flight; maxInFlight 1 runs them one after the other with the whole budget.
2. Caller-visible failure: Too many simultaneous render processes exhaust resources, or sequential mode starts work too early.
3. Oracle: At most four starts until completion; maxInFlight 1 delays second start and honors desired grant.
4. Stable seam: task scheduler caller contract (resource grants, ordered results, progress and abort).
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Separate from page count: many one-page tasks can satisfy page budget while violating process limit.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/page-pool.test.ts --maxWorkers=1`.

### KEEP: aggregates progress by weight and counts finished renders
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes design; exact protected behavior: aggregates progress by weight and counts finished renders.
2. Caller-visible failure: Export progress reports wrong completion percentage when tasks have unequal durations.
3. Oracle: Explicit 30:10 weights give 15/40 then 25/40 then 1; completion counts follow controlled task completion.
4. Stable seam: task scheduler caller contract (resource grants, ordered results, progress and abort).
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only progress accounting owner; artifact exports can succeed while reporting incorrect progress.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/page-pool.test.ts --maxWorkers=1`.

### KEEP: the first failure aborts the renders in flight, starts no more, and rejects once all have settled
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes design; exact protected behavior: the first failure aborts the renders in flight, starts no more, and rejects once all have settled.
2. Caller-visible failure: A failed bake leaves siblings working, starts pending work, or loses the original render error.
3. Oracle: Injected failing task produces RENDER_FAILED, signals sibling abort and never starts pending task.
4. Stable seam: task scheduler caller contract (resource grants, ordered results, progress and abort).
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Controlled scheduling isolates first-error propagation; explicit user cancellation tests are a different trigger.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/page-pool.test.ts --maxWorkers=1`.

### KEEP: aborting the signal cancels every render in flight and rejects with JOB_CANCELLED
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes design; exact protected behavior: aborting the signal cancels every render in flight and rejects with JOB_CANCELLED.
2. Caller-visible failure: Cancelling export leaves background renders or starts work despite an already-aborted signal.
3. Oracle: JOB_CANCELLED, every started task sees abort, pending tasks never start; pre-aborted pool rejects.
4. Stable seam: task scheduler caller contract (resource grants, ordered results, progress and abort).
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Scheduler lifetime boundary used by two production owners; E2E queue cascade alone does not exercise already-aborted startup.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/page-pool.test.ts --maxWorkers=1`.

## apps/engine/test/layer-bake.test.ts
Independent source: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5. Owner read: `src/layer-bake/layer.ts, key.ts, service.ts, extension.ts and routes/layer-bake.ts`. Non-test callers: extension and preview route call planBake; service calls static classification; extension calls effect-order warning; production GC/lookup/lease callers protect cached output.

### DELETE: claims text, shapes and anime templates but leaves fframes templates alone
Private classification assertion duplicates the retained hybrid-plan HTTP test and anime route tests; no unique caller outcome.
Risk: low; stronger coverage is identified above.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: static = no animator, no keyframes anywhere, no anime template, no unknown effect
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: static = no animator, no keyframes anywhere, no anime template, no unknown effect.
2. Caller-visible failure: An animated/unknown-effect layer is cached as one frame and freezes during playback.
3. Oracle: Fixed static/animated classifications for opacity, shape properties, text animation, anime templates and unknown effects.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Lowest pure classification boundary; rendered E2E includes only representative known effects and not each classification hazard.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: a keyframed grade does not make a DOM layer a master: colour runs are applied by ffmpeg (LBK-010).
2. Caller-visible failure: A static title with animated color unnecessarily renders an entire browser master instead of applying native color over a still.
3. Oracle: Removing color ops leaves an empty effect stack and static classification even with animated exposure.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Different from output color parity: both slow master and intended still may look identical, so storage recipe selection needs this owner.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: changes with text, font, bundle, anime.js, Remotion, browser and GL; not with time or duration.
2. Caller-visible failure: Cache reuses stale title/font/environment output or invalidates unchanged output after time-only edits.
3. Oracle: Same key after move/trim; distinct keys after content, font, bundle, anime, Remotion, browser or GL changes.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Lowest storage identity boundary; one rendered cache hit cannot cover every independent invalidation input.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: identical titles share a bake unless they are seeded by their clip id (text animators, anime templates)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: identical titles share a bake unless they are seeded by their clip id (text animators, anime templates).
2. Caller-visible failure: Seeded animations collide in cache, or identical unseeded titles bake redundantly.
3. Oracle: Equal unseeded title keys; different clip-seeded keys and changed keys for changed animation order/window.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Unique seed-sensitive storage contract; ordinary text/environment key changes do not test clip identity semantics.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: another title using a different font weight does not invalidate this title’s bake
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: another title using a different font weight does not invalidate this title’s bake.
2. Caller-visible failure: Editing an unrelated font weight invalidates an unchanged title cache.
3. Oracle: The original title key remains identical when another title introduces bold font.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Specific documented review regression; changing the tested title font covers the opposite case.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: footage with text, shape and anime layers has a hybrid export plan
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: footage with text, shape and anime layers has a hybrid export plan.
2. Caller-visible failure: The planner rejects supported mixed graphics or drops some graphics from native preparation.
3. Oracle: HTTP plan has hybrid path, no blockers, native audio and exact authored graphic item IDs; forced native still hybrid.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only mixed text/shape/anime routing test. Generic text-over-footage plans omit other renderer classifications.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### REWRITE: a forced native plan rejects a graphics layer when Remotion is unavailable
LBK-024 must reject graphics when the configured renderer is unavailable. Replace private method monkeypatch with strict engine configuration pointing at a missing binary directory; assert public plan error.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: a forced native plan rejects a graphics layer when Remotion is unavailable.
2. Caller-visible failure: A forced-native graphics export is accepted when the configured renderer cannot bake it.
3. Oracle: Strict missing-binaries configuration produces HTTP 409 PATH_NOT_ELIGIBLE.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Tests actual configuration-to-planner enforcement; needs-download case intentionally remains eligible.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: `needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: `needs-browser-download` is not a blocker (warning BROWSER_DOWNLOAD).
2. Caller-visible failure: An engine that can download Chrome incorrectly blocks a valid export.
3. Oracle: Explicit needs-browser-download capability yields hybrid plan with BROWSER_DOWNLOAD warning.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Covers readiness distinction, not generic ready/unavailable tests.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: warns when a colour effect precedes a pixel-mixing effect on a DOM layer
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: warns when a colour effect precedes a pixel-mixing effect on a DOM layer.
2. Caller-visible failure: Users are not told that color/blur order changes the rendered result.
3. Oracle: Color-before-blur yields warning; reversed order yields none.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Lowest warning predicate boundary; actual pixels can differ acceptably while warning remains mandatory.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: GC removes entries unused for 14 days and keeps the others
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: GC removes entries unused for 14 days and keeps the others.
2. Caller-visible failure: Disk grows indefinitely or recently reused output disappears.
3. Oracle: Entries 15 days old and old orphan are deleted; 13-day entry remains and serves PNG, private metadata stays inaccessible.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Real storage/route test; key identity tests do not run retention or file serving.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: GC keeps leased entries and entries a lookup marks used meanwhile (review fix 4)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: GC keeps leased entries and entries a lookup marks used meanwhile (review fix 4).
2. Caller-visible failure: An active export loses its leased/cache-hit master during garbage collection.
3. Oracle: Leased old entry survives until release; looked-up old entry survives; concurrent lookup never returns a deleted path.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Documented lifetime/race regression; ordinary retention test has no active reader.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: graded masters are PNG frame sequences served per frame under one signed URL (review fix 1)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: graded masters are PNG frame sequences served per frame under one signed URL (review fix 1).
2. Caller-visible failure: Remotion fetches the wrong graded frame or accesses an invalid frame path.
3. Oracle: Known frame bytes for n=0/1, fixed PNG MIME, 404 for missing/negative/fractional/non-numeric frame selectors.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only frame-selector HTTP boundary; rendered fade test cannot exhaust malformed selector inputs.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: features.layerBake reports readiness and the cache size
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: features.layerBake reports readiness and the cache size.
2. Caller-visible failure: Clients cannot discover whether graphics baking is available or cache usage.
3. Oracle: Capability has legal ready/unavailable state and numeric cacheBytes.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only this feature capability API assertion; media rendering can work while discovery is absent.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

### KEEP: POST /api/layer-bake/preview validates the request and the clip
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-001/004/010/020/021/024/030; documented review fixes 1/4/5; exact protected behavior: POST /api/layer-bake/preview validates the request and the clip.
2. Caller-visible failure: Invalid preview input is accepted or unsupported clips reach expensive baking.
3. Oracle: Fixed 400/404/422 and LAYER_NOT_GRADED/NOT_A_GRAPHICS_LAYER for authored cases.
4. Stable seam: storage planning/GC operations and public HTTP plan/preview/file APIs.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only request validation boundary; successful preview artifacts cannot catch invalid-request acceptance.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.test.ts --maxWorkers=1`.

## apps/engine/test/layer-bake.e2e.test.ts
Independent source: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1. Owner read: `src/layer-bake/service.ts, extension.ts, export/native.ts and export/service.ts`. Non-test callers: export service invokes native extensions and Remotion; preview route invokes baking and grading.

### REWRITE: plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %)
Retain rendered composite parity, artifact kinds, actual cache reuse and required usage log. Remove dependence on child-job display-title wording and non-null crop rectangles: either a full-frame or cropped master may render identical correct pixels.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: plans hybrid; bakes one PNG per static layer; the output matches a full Remotion render (≤ 3/255 on 99 %).
2. Caller-visible failure: Hybrid export loses graphics, repeats frames, mishandles crop or skips required Remotion usage records.
3. Oracle: Independent full-frame browser renders agree within specified 3/255 on 99%; expected static/master recipes, real usage records and cache hit.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Critical mixed export artifact owner; helper tests cannot detect renderer/compositor integration failures.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: masters keep straight alpha: over R/G/B/W within 2/255 of the browser still
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: masters keep straight alpha: over R/G/B/W within 2/255 of the browser still.
2. Caller-visible failure: Master pixels use premultiplied alpha and produce dark fringes when composited.
3. Oracle: Independent browser RGBA still vs decoded master composited over fixed red/green/blue/white; nonvacuous semi-transparent sample count and 2/255 limit.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only direct alpha fidelity check over several backgrounds; full-frame parity tolerances can hide edge corruption.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### DELETE: re-exports hit the cache; moving a title in time hits it too; a text change bakes again
Cache identity is owned by three planBake storage-contract tests; the first retained export already checks real cache reuse. The purported moved-frame assertion only demands differing whole frames and passes because unrelated layers animate.
Risk: low; stronger coverage is identified above.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: stills take the same path: cached masters are reused, else one frame per layer is baked (LBK-025).
2. Caller-visible failure: Still jobs ignore cached masters or bake an entire animation unnecessarily and show the wrong frame.
3. Oracle: Cached still equals decoded exported frame; fresh animated still produces exactly one one-frame bake.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Still-only cache/one-frame recipe owner; export artifact test cannot exercise still fallback recipe.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: a Lumetri grade on a title shows in the native export, the Remotion export and the graded preview (FIX-002).
2. Caller-visible failure: Color is absent on text in native, browser or preview outputs.
3. Oracle: Authored saturation zero turns red glyph pixels gray with bounded brightness; three actual path outputs agree and preview bytes serve.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: DOM grading uses baked alpha master path, unlike media color tests; no lower test catches omitted cross-path adaptation.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### REWRITE: a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1)
Credible double-fade/alpha regression remains; replace expected timing derived from production snapshot with explicit sequence frame and half-fade values from the authored transition contract.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: a graded static title fades through its transition once on every path: native, Remotion, preview (review fix 1).
2. Caller-visible failure: Graded title fade is applied twice or opaque black replaces transparent background.
3. Oracle: Authored one-sided 10-frame fade starts at 10; frame 15 has half contrast, frame 35 full contrast, background remains gray.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Specific documented double-fade/alpha regression not exercised by unfaded saturation-zero title.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 §11 acceptance 4, LBK-003/023/025/026, FIX-002 and documented review fix 1; exact protected behavior: a failing bake: `auto` falls back to Remotion with a warning, forced native fails (LBK-023).
2. Caller-visible failure: Auto export aborts instead of falling back, or forced-native silently changes render engine.
3. Oracle: Real resulting auto export reports remotion and NATIVE_FALLBACK; forced-native preserves LAYER_BAKE_FAILED.
4. Stable seam: export/still/preview API and independently decoded output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only fallback orchestration contract; controlled dependency failure supplies the trigger, but does not implement fallback or returned artifact.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## apps/engine/test/layer-bake-parallel.e2e.test.ts
Independent source: S11 LBK-022; wp-m2-layer-bake Parallel bakes equivalence and Abort design. Owner read: `src/layer-bake/extension.ts, service.ts and remotion/page-pool.ts`. Non-test callers: native extension schedules real bakes and queue cancellation cascades to children.

### KEEP: parallel bakes overlap and produce the same decoded composite as sequential bakes
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes equivalence and Abort design; exact protected behavior: parallel bakes overlap and produce the same decoded composite as sequential bakes.
2. Caller-visible failure: Scheduling serializes all bakes or concurrent/shared-browser execution corrupts frames.
3. Oracle: Recorded job time spans overlap; independent sequential and parallel exported composites decode identically.
4. Stable seam: export jobs and decoded composite artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Pool unit tests cannot detect browser shared-window rendering interactions; text/shape E2E does not compare schedules.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake-parallel.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: cancelling the export cancels bakes already in flight
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 LBK-022; wp-m2-layer-bake Parallel bakes equivalence and Abort design; exact protected behavior: cancelling the export cancels bakes already in flight.
2. Caller-visible failure: Cancel returns while child renders continue or fail spuriously.
3. Oracle: Running child jobs reach cancelled/settled states, parent is cancelled, no failed children.
4. Stable seam: export jobs and decoded composite artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Real renderer cancellation boundary; synthetic scheduler tasks do not start browser/ffmpeg child jobs.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/layer-bake-parallel.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## apps/engine/test/mg.test.ts
Independent source: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs. Owner read: `src/routes/mg.ts and src/mg/service.ts`. Non-test callers: MG routes register real external queue source/master provider and invoke service validation/render.

### KEEP: degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: degrades gracefully: TS catalog flagged native:false, render → 503 MG_UNAVAILABLE.
2. Caller-visible failure: Missing jasper-mg removes the template catalog or renders with a misleading success/error.
3. Oracle: Unavailable renderer/capability, lower-third native false and HTTP 503 MG_UNAVAILABLE.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only missing native-binary HTTP behavior; available-render tests and anime refusal cover different conditions.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

### REWRITE: validates requests and file names
The previous 404 checks used only nonexistent files, so they could pass without path validation. Populate a valid master and existing forbidden-path targets before checking successful bytes and rejected requests; retain HTTP request validation.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: validates requests and file names.
2. Caller-visible failure: Invalid dimensions reach rendering or forbidden existing cache paths leak file bytes.
3. Oracle: Width zero gives VALIDATION_FAILED; known valid master serves; existing invalid-key/traversal targets return 404.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Lowest MG HTTP file boundary, separate from measurement-server and layer file routes.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

### REWRITE: renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master
S04/MGT master media, alpha, range serving and cache reuse remain. Remove scheduler slot count, exact directory inventory, duplicated catalogue checks and private master-provider echo; retained real exported pixels and ffprobe protect actual artifact.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master.
2. Caller-visible failure: A completed render has wrong codec/frame count/alpha or unusable preview/range/cache behavior.
3. Oracle: ffprobe 150-frame ProRes 4444 dimensions, independent fixed panel RGBA bounds, real byte-range response and equivalent request cache reuse.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only actual native jasper-mg master artifact; Remotion MG bundles use a different renderer.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

### KEEP: mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: mg-render jobs are listed, cancelled and retried through /api/jobs (WP-3I).
2. Caller-visible failure: MG jobs are invisible to shared job APIs or cannot be cancelled/retried.
3. Oracle: Submitted real job appears in list/get, cancels, retry returns distinct MG job that also cancels.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: External-source job adapter is not used by native queue unit jobs; no other test exercises it.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

### KEEP: rejects invalid params with 400 and cancels running renders without leftovers
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: rejects invalid params with 400 and cancels running renders without leftovers.
2. Caller-visible failure: Unknown template/params reach rendering or cancelled render leaves partial master files.
3. Oracle: Fixed INVALID_SPEC/TEMPLATE_NOT_FOUND plus final cancelled state and absent master/empty output directory.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Distinct from shared jobs API: validates MG registry errors and actual filesystem cleanup.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

### KEEP: uses the TS registry to validate and keys renders deterministically
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S04 motion graphics API, MGT master/cache contract and WP-3I external jobs; exact protected behavior: uses the TS registry to validate and keys renders deterministically.
2. Caller-visible failure: Equivalent prop object key order misses cache or changed duration reuses stale master.
3. Oracle: Equal keys for name/title order changes; unequal for 150 vs 151 frames.
4. Stable seam: MG HTTP API, real ProRes master/Range bytes, scheduler jobs and storage identity.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Lowest native-MG storage identity contract; default-expanded real render reuse does not permute key order or duration.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg.test.ts --maxWorkers=1`.

## apps/engine/test/mg-text-measure.test.ts
Independent source: S08 MGC-037 private loopback measurement boundary. Owner read: `src/mg-bundles/text-measure.ts`. Non-test callers: measureBundleTexts opens serveBundleForMeasuring and reads bundle assets.

### REWRITE: serves the host page with the probe, the bundle files under its prefix, nothing else
MGC-037 server is a security boundary. Keep real loopback HTTP bytes, MIME, prefix isolation and traversal against an existing outside file; remove private injected-global grep, script ordering and random-token format inventory. Browser mg-bundles tests own probe functionality.
1. Independent requirement: S08 MGC-037 private loopback measurement boundary; exact protected behavior: serves the host page with the probe, the bundle files under its prefix, nothing else.
2. Caller-visible failure: Measurement server exposes outside files, has no path isolation, or cannot serve bundle JS/fonts.
3. Oracle: Real HTTP returns exact fixture JS/MIME; existing outside secret and unprefixed file both return 404; loopback hostname.
4. Stable seam: real HTTP serving/security boundary.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only isolated private-server security boundary; browser text probe checks actual measuring but not hostile paths.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/mg-text-measure.test.ts --maxWorkers=1`.

## apps/engine/test/remotion.e2e.test.ts
Independent source: S04 RR-001…006. Owner read: `src/remotion/service.ts and export/service.ts`. Non-test callers: export service uses Remotion renderer and serves render output.

### KEEP: renders 30 frames of a text-only sequence and a still
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S04 RR-001…006; exact protected behavior: renders 30 frames of a text-only sequence and a still.
2. Caller-visible failure: Normal Remotion export/still APIs produce unreadable output or wrong frame count.
3. Oracle: Actual HTTP jobs succeed on remotion path; ffprobe reads authored 30 frames/size; PNG served.
4. Stable seam: HTTP export/still plus ffprobe output artifact.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Critical normal renderer workflow with screen blend; strict LGPL tests exercise different executable/encoding configuration.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## apps/engine/test/remotion-lgpl.e2e.test.ts
Independent source: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract. Owner read: `src/tools/lgpl.ts, src/remotion/service.ts and export/service.ts`. Non-test callers: core resolves binary configuration; Remotion exports invoke compositor and selected encoder.

### KEEP: reports the LGPL directory in /api/capabilities (strict mode accepts it)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract; exact protected behavior: reports the LGPL directory in /api/capabilities (strict mode accepts it).
2. Caller-visible failure: Packaged strict configuration refuses valid LGPL binaries or misreports license/source.
3. Oracle: Strict real engine capabilities report ready, env binaries and LGPL license for renderer/native media.
4. Stable seam: strict-mode HTTP capabilities and real binary/export/still artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Resolver unit fixtures cannot prove installed executables initialize successfully in a real engine.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract; exact protected behavior: its ffmpeg is an LGPL build (no --enable-gpl / --enable-nonfree / x264).
2. Caller-visible failure: Distribution contains a GPL/nonfree-enabled compositor FFmpeg.
3. Oracle: Real -buildconf excludes fixed GPL/nonfree codecs and -L reports GNU Lesser license.
4. Stable seam: strict-mode HTTP capabilities and real binary/export/still artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Legal binary bytes/config contract, not source grep; selection tests alone trust supplied metadata.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: exports H.264 via a Remotion ProRes intermediate encoded with OpenH264
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract; exact protected behavior: exports H.264 via a Remotion ProRes intermediate encoded with OpenH264.
2. Caller-visible failure: Strict Remotion export fails its LGPL intermediate encoding pipeline or produces wrong media/audio/color tags.
3. Oracle: Real ffprobe H264/AAC, authored 24 frames/640x360/BT709, non-GPL chosen OpenH264 encoder; artifact lacks x264 banner.
4. Stable seam: strict-mode HTTP capabilities and real binary/export/still artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only installed compositor → ProRes → OpenH264 path; native export and direct VP9 take different owners.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### KEEP: exports VP9/Opus WebM directly through Remotion
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract; exact protected behavior: exports VP9/Opus WebM directly through Remotion.
2. Caller-visible failure: Direct Remotion WebM encoding fails or drops Opus audio.
3. Oracle: Actual WebM file has VP9/Opus and authored 24 frames/dimensions, result direct mode.
4. Stable seam: strict-mode HTTP capabilities and real binary/export/still artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Different direct-encoder path from H264 intermediate; retained because each has independent failure mode.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### REWRITE: renders a still through the LGPL compositor
D-13 compositor workflow currently permits a hybrid still, missing its claimed Remotion contract. Give this still a supported screen blend and require renderPath remotion so failure is attributable to the intended path.
1. Independent requirement: ARCHITECTURE D-13; wp-lgpl shipped LGPL compositor contract; exact protected behavior: renders a still through the LGPL compositor.
2. Caller-visible failure: Strict LGPL compositor cannot generate a Remotion still.
3. Oracle: Authored screen-blend still explicitly returns remotion path and serves PNG bytes.
4. Stable seam: strict-mode HTTP capabilities and real binary/export/still artifacts.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: The API previously took hybrid path; this is the only strict Remotion still renderer check.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/remotion-lgpl.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## apps/engine/test/shapes-remotion.e2e.test.ts
Independent source: S11 SHP-004 and explicit rendered geometry acceptance. Owner read: `packages/compositions/src/layers/ShapeLayer.tsx, packages/project/src/render/shape.ts`. Non-test callers: ShapeLayer and layer-bake renderer consume shared document shape values.

### KEEP: edges, stroke widths and colours of rect / circle / ellipse with inside, outside and centre strokes
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S11 SHP-004 and explicit rendered geometry acceptance; exact protected behavior: edges, stroke widths and colours of rect / circle / ellipse with inside, outside and centre strokes.
2. Caller-visible failure: Shape exports violate specified inside/center/outside stroke geometry or fill/alpha colors.
3. Oracle: Analytic scene from fixed authored geometry, sampled stroke widths/interiors and whole-frame pixel tolerances.
4. Stable seam: PNG still compared to analytic geometric scene independent of renderer.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Explicit S11 rendered geometry acceptance exception; model shape evaluations cannot detect SVG clip/mask raster errors.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/shapes-remotion.e2e.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## apps/engine/test/color.test.ts
Independent source: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5. Owner read: `src/color/prober.ts, extension.ts, routes/color.ts and export/native.ts`. Non-test callers: media asset prober reads cubes; native extension prepares actual LUT files consumed by ffmpeg.

### KEEP: registers a vendor-style 33³ .cube as kind lut with its header
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: registers a vendor-style 33³ .cube as kind lut with its header.
2. Caller-visible failure: Imported 3D LUT metadata or served file bytes are corrupted.
3. Oracle: Fixed fixture header (33 cubed, title/domain) and exact original .cube bytes through media route.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only engine LUT registration/serving path; parseCube library tests never run asset-prober registration.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### KEEP: registers a 1D LUT (LUT-004)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: registers a 1D LUT (LUT-004).
2. Caller-visible failure: Supported one-dimensional LUT import is misclassified or refused.
3. Oracle: Fixture produces dimensions 1, size 1024 and authored title.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Different LUT dialect; 3D registration does not exercise 1D metadata.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### KEEP: rejects broken files with the parser line number
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: rejects broken files with the parser line number.
2. Caller-visible failure: Users import malformed LUTs with no actionable line error or bogus media record.
3. Oracle: No registered items, INVALID_LUT, fixed fixture error lines 7 and 6.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Engine translates parser errors into media API results; parser-only tests cannot catch translation/registration mistakes.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### KEEP: reports features.color (lut3d in the engine ffmpeg)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: reports features.color (lut3d in the engine ffmpeg).
2. Caller-visible failure: Clients disable grading despite engine support or fail capability discovery.
3. Oracle: Actual engine reports lut3d true for its ffmpeg.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only color capability provider integration; rendering does not assert capability publication.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### REWRITE: plans graded clips natively without GPL-only filters
Revised after reading S06 CG-054 and §9.5 in full: generated FFmpeg filter names are an explicitly required output-protocol contract. Preserve the scan, add a positive `lut3d` assertion so an empty graph cannot pass, and collapse the repeated preparations into one representative stack including legacy effects.
1. Independent requirement: S06 CG-053/054 explicitly requires a native plan and excludes named GPL filters from generated filter text.
2. Caller-visible failure: a graded native export would fail against shipped LGPL FFmpeg or use forbidden functionality.
3. Oracle: fixed forbidden protocol filter names plus required `lut3d`; never calculated from the graph builder.
4. Stable seam: native graph's FFmpeg filter-language output consumed by the executable.
5. Refactor tolerance: renaming/reorganizing TS symbols does not affect protocol names; no graph label/order snapshot.
6. Unique lowest owner: binary-license tests cannot catch a future color extension emitting an unsupported filter; decoded output tests on a developer GPL ffmpeg can still pass. One graph covers both Lumetri and legacy effects.
Non-test callers: export service uses native graph; native color extension prepares the color LUTs. Risk low; smallest validation `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### KEEP: keyframed export frames match the start and end grades
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: keyframed export frames match the start and end grades.
2. Caller-visible failure: Color stays frozen or wrong LUT is selected for start/end video frames.
3. Oracle: Decoded endpoints match independently authored static-grade stills; opposite endpoint differs substantially.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Tests frame-window/native export integration; still reference test has no animated color.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

### KEEP: native still parity with the TS reference on the chart (S06 §9 test 3: ≤ 2/255 on 99.5 %, max ≤ 4)
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 LUT-001/004, CG-050…054, §9 acceptance 2/3/5; exact protected behavior: native still parity with the TS reference on the chart (S06 §9 test 3: ≤ 2/255 on 99.5 %, max ≤ 4).
2. Caller-visible failure: FFmpeg LUT interpolation, range conversion or quantization diverges from the specified preview reference.
3. Oracle: S06 explicitly defines applyLut of baked LUT as reference; decoded native pixels meet 99.5%/2 and max4 thresholds and visibly differ from ungraded chart.
4. Stable seam: LUT registration/file HTTP; decoded export/still media.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Maths tests validate grade model; this unique test validates external FFmpeg application of that reference, not bakeColorRun against itself.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color.test.ts --maxWorkers=1`.

## apps/engine/test/color-remotion.test.ts
Independent source: S06 CG-042, §9 acceptance 6. Owner read: `src/remotion/service.ts and packages/compositions color stage`. Non-test callers: export still path checks WebGL then invokes compositions color stage.

### KEEP: an engine without WebGL2 fails a graded Remotion still with WEBGL_UNAVAILABLE
The named contract has a concrete failure not checked by another retained test at this seam.
1. Independent requirement: S06 CG-042, §9 acceptance 6; exact protected behavior: an engine without WebGL2 fails a graded Remotion still with WEBGL_UNAVAILABLE.
2. Caller-visible failure: Graded browser render silently omits grading without WebGL2.
3. Oracle: GL-off config leads accepted job to failed WEBGL_UNAVAILABLE.
4. Stable seam: GL configuration error and actual browser-rendered PNG.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Only explicit GL-unavailable configuration failure; real browser success test must not stand in for it.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color-remotion.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

### REWRITE: a graded chart + (blank) text still matches the TS reference (≤ 2/255 on 99.5 %)
CG-042/§9.6 rendered parity must actually render. Remove the conditional success on WEBGL_UNAVAILABLE; the separate GL-off test owns that error contract.
1. Independent requirement: S06 CG-042, §9 acceptance 6; exact protected behavior: a graded chart + (blank) text still matches the TS reference (≤ 2/255 on 99.5 %).
2. Caller-visible failure: Browser/WebGL applies different grading than specified reference or never renders at all.
3. Oracle: WebGL state must be ok; actual decoded PNG matches explicit S06 TS-reference contract at 99.5%/2.
4. Stable seam: GL configuration error and actual browser-rendered PNG.
5. Refactor tolerance: no private collaborator call counts or identifier inventories; the same inputs and observable contract remain valid after owner rearrangement.
6. Lowest/unique owner: Browser shader/texture stage differs from FFmpeg stage; native parity cannot detect it.
Risk: retains existing product contract; configured binary/browser integration gates may require installed assets.
Validation: `pnpm --filter @jasper/engine exec vitest run test/color-remotion.test.ts --maxWorkers=1` with `REMOTION_E2E=1` for browser cases.

## Additional seam disposition before editing

DELETE `src/routes/layer-bake.ts:layerBakeService`: repository-wide call search finds only the three retained layer-bake test files. It is a nullable wrapper around the public engine service registry, with no production caller. Those tests can use the existing plugin registry directly. The service registration and all production behavior stay unchanged. Risk low; validation is the layer-bake suites plus typecheck.

## Completed cleanup and validation evidence

Cleanup is implemented, not audit-only. The original-name disposition ledger above covers all 62 tests in this scope. `mg-text-measure` now names its actual retained security contract: “serves bundle files under its loopback prefix and refuses existing files outside it”.

Removed support: generated-filter test duplicate preparation and unused extra fixture setup; direct isDomLayer import; registry-derived anime count oracle imports; MG private master-provider probe and cache-directory inventory; bake job-title lookup/crop-only assertions; layerBakeService export wrapper (five production lines). All remaining referenced shared fixtures/helpers have other retained callers. No production rendering behavior changed. Scope test LOC is net-negative by 110 lines; production LOC is net-negative by five lines.

Validation:

- Initial sequential focused run: `pnpm --filter @jasper/engine exec vitest run test/anime.test.ts test/anime-scaffold.test.ts test/anime-templates.test.ts test/page-pool.test.ts test/layer-bake.test.ts test/mg.test.ts test/mg-text-measure.test.ts test/color.test.ts test/color-remotion.test.ts --maxWorkers=1`: 41 passed, one browser-gated test skipped, three timeouts; nine files, 664.76 seconds. The run began before editing and loaded later files while cleanup proceeded, so this is not a pristine full-baseline claim. Timeouts were anime license HTTP startup (5 seconds), MG unavailable HTTP startup (5 seconds), and actual MG 150-frame render (120 seconds). No assertion mismatch was reported.
- Focused retry of anime/MG/text-measure/layer-bake/color with `--maxWorkers=1 --testTimeout=120000` was explicitly stopped for the root's central full gate. Before interruption, MG completed five passing tests and the real 150-frame master again hit its explicit 120-second timeout. This retry is incomplete, not a pass. Only its owned process tree was terminated.
- Biome passed on every changed test/production file; `git diff --check` passed.
- Root owns final lint/typecheck/full test gates and gated browser validation. No claim that REMOTION_E2E workflows ran in this subtask. Modified browser cases needing that gate: mixed hybrid artifact workflow, graded-title half-fade, strict LGPL Remotion still, and actual WebGL color parity.

Pre-edit harness adjustment: `apps/engine/test/mg.test.ts` / `renders lower-third 1920x1080 @30 for 150 frames into a verified ProRes 4444 master` reached the uncontracted 120-second test-completion deadline during the final root run under unrelated host compiler load of 80–135. Raise only the completion budget to 600 seconds; preserve all codec, frame-count, alpha and pixel assertions. No production changes. Root will rerun the failed files; scoped Biome/diff checks follow this edit.

Final root rerun: all 6 native motion-graphics engine tests passed with the 150-frame/codec/alpha assertions intact. All 34 tests across the seven opt-in engine render files passed separately. Full repository results are in [the completion report](test-cleanup-summary-round2.md).
