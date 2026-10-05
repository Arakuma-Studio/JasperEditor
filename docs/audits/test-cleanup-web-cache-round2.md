# Remote-merge audit: web cache preferences and motion-graphics host budget

Completed cleanup; the disposition ledger was recorded before test edits. Scope: `apps/web/test/media-cache.test.tsx` and `apps/web/test/mg-runtime-budget.test.ts`; production owners read: `src/cache/MediaCachePage.tsx`, `src/mg-bundles/runtime.ts`, `src/state/engine.tsx` (all under `apps/web`). Requirements read: S04 CA-013–021 and S08 MGC-024/MGU-005, plus the documented first-come budget deviation in `docs/wp-notes/wp-m2-mg.md` and `wp-m3-mgtext.md`. Host-wide AGENTS instructions apply. Commands are root `pnpm test`, `pnpm lint`, `pnpm typecheck`; focused command below.

## Pre-edit disposition ledger

All media-cache rows refer to `apps/web/test/media-cache.test.tsx`.

| Disposition | Original test | Failure detected / reason | Remaining stronger coverage | Risk |
| --- | --- | --- | --- | --- |
| DELETE | shows the usage per kind, the total against the limit and the location | Mostly presentation copy, row count, and bar existence; data display already exercised through real engine. Fails bars 5/6. | `e2e/media-cache.spec.ts` open-project usage workflow; engine `cache.test.ts` CA-013 usage test. | Low; incidental text/placeholder changes no longer fail. |
| DELETE | Clean Unused runs at once; Clean All asks first and runs only when confirmed | Same confirmation/cleaning workflow replayed against a fabricated engine; exact report wording adds no contract. Fails bar 6. | `e2e/media-cache.spec.ts` cancellation/confirmation with real cache files; engine CA-014 protection tests. | Low; real protected-file evidence remains. |
| DELETE | saves the automatic-cleaning settings as one object and validates them | E2E owns browser-to-persisted-settings conversion; error wording and comma acceptance lack independent requirements. Invalid settings are enforced by API. Fails bars 1/6 for added claims. | E2E settings workflow and engine `validates and persists the settings (engine/cache.json)`. | Low; frontend-specific copy and permissive comma parsing cease to be locked down. |
| DELETE | a kind can be set to "never"; logs show their size and their own limits | Duplicates E2E per-kind null retention and log settings; malformed text only asserts wording, not absence of an API write. Fails bar 6; negative branch also fails bar 2. | E2E automatic settings test; engine cache settings and logs retention tests. | Low. |
| DELETE | Change… checks a folder, refuses an unusable one, moves with progress and refreshes | Fake server implements the move it reports; real move, new location, and files are E2E-owned. Disabled button alone is weaker than engine rejection of unsafe target. Fails bar 6. | E2E real move/back workflow; engine `cache-location.test.ts` invalid-target 422 and filesystem/restart tests. | Low; checking UI wording no longer required. |
| DELETE | Edit ▸ Preferences ▸ Media Cache… opens the page | Export inventory/menu-object walk followed by direct render never executes the menu command. Fails bars 2/4/5; actual navigation already E2E-owned. | E2E opens Edit → Preferences → Media Cache. | Low. |

Motion-graphics rows refer to `apps/web/test/mg-runtime-budget.test.ts`.

| Disposition | Original test | Failure detected / reason | Remaining stronger coverage | Risk |
| --- | --- | --- | --- | --- |
| REWRITE | gives 4 slots first-come; an edited clip takes the farthest holder’s slot until the edit ends | Preserve host allocation/eviction/release outcomes, reorder fixture starts so farthest holder is not the first mounted. Original fixture could not distinguish distance from first-holder eviction. | `e2e/mg-texts.spec.ts` covers real editing integration but its holders share starts and cannot distinguish distance selection. | Low; stronger independent distance oracle. |
| REWRITE (merge) | an edited clip that already holds a slot evicts nobody and never shows the cached preview | Fold occupied-slot no-eviction assertion into preceding lifecycle. Delete `previewFor(...) === null`: no preview was cached, so it passes even when edit bypass is removed. | MGU-005 E2E exercises live text editing; merged unit owns unique already-held slot branch. | Low; no real cached-preview protection existed in deleted assertion. |

## Six-bar justification for rewritten host-budget lifecycle

1. Independent contract: S08 MGC-024 caps hosts at four; MGU-005 grants a missing slot to the edited clip by borrowing the farthest holder until editing ends. Work-package notes explicitly document first-come allocation for ordinary clips. Already-hosted editing must retain other available holders, following the cap and conditional borrowing rule.
2. Recognizable failures: wrong clip loses live rendering, editing never gets a live host, more than four hosts run, ending editing fails to restore ordinary allocation, or releasing a holder leaves another clip unnecessarily idle.
3. Independent oracle: hand-chosen clip positions `[200, 0, 300, 100, 400]` and playhead 420 identify the second mounted holder as farthest, with literal expected eligibility lists. No production constant or distance helper derives expectations.
4. Stable seam: `CompositionPreviewRuntime.acquireHost/hostAllowed` are called by production `CompositionLayer`; `CanvasTextEditor` calls `setTextEditing`. These are runtime behavior interfaces, not private collaborator spies.
5. Refactor resilience: only clip allocation outcomes are observed; internal sets/maps, notification scheduling, eviction bookkeeping, and source names may change.
6. Lowest owner: runtime allocation owns this decision. Browser E2E owns actual text editing but uses equal-start holders, so it cannot distinguish a wrong distance policy or test release eligibility.

## Seams and support

Deleting media-cache removes its local fake HTTP engine, usage/report/job fixtures, mount helper, and menu traversal. No snapshots. `MediaCachePreferencesPage`, runtime host methods and editing methods all have production callers and remain. `EngineProvider.connectEvents` is an existing shared test flag used by numerous remaining suites; flag removal requires cross-suite coordination and is reported to the parent audit. Shared inspector helpers still have multiple test callers.

## Validation

Baseline and post-edit focused command: `pnpm exec vitest run apps/web/test/mg-runtime-budget.test.ts apps/web/test/media-cache.test.tsx` (after deletion, run only the surviving host-budget file). Repository-wide gates are coordinated by the root agent.

Results: baseline passed both files (8/8 tests). Post-edit focused host-budget run passed (1/1); `pnpm exec biome check apps/web/test/mg-runtime-budget.test.ts` passed; scoped `git diff --check` passed. Final diff inspected: 6 deleted tests, 2 rewritten into 1, net −351 test lines. No production behavior changed.
