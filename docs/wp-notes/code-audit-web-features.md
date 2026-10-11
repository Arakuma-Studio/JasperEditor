# Web feature code audit

Scope: feature directories under `apps/web/src`, excluding panels, commands, shell, runtime, state, home,
agent-bridge, PWA, i18n, and root files. The audit used the project architecture, existing feature notes,
project command/model definitions, API contracts, import-reference searches, and existing tests. No purchased
reference material or third-party assets were accessed.

## Critical assessment

The feature layer has substantial working implementations, but accumulated parallel work left duplicated
lifecycle helpers, obsolete rendering code, and assertions that conceal types already available from the
model. Error handling generally protects real boundaries: network jobs, browser storage, third-party bundles,
clipboard permissions, and interrupted gestures. Removing these boundaries indiscriminately would violate
the project's crash and work-preservation requirements.

The highest-confidence findings and implementations are:

- `CompositionSection` and `CompositionTexts` imported each other. Both now depend on `PropEditor`, which
  owns the schema-driven property controls and their private helpers. The runtime import cycle is removed.
- Seven dialog modules duplicated close-state handling; six used asynchronous React state as an idempotence
  guard. A shared generic `useDialogClose` uses a ref so primary action and dialog-close notifications cannot
  invoke the hosted callback twice within one render.
- Tracking, roto, camera tracking, and mask tracking silently retried every failed job lookup indefinitely.
  `pollActiveJob` shares ownership checks, terminal-state detection, and a three-consecutive-transient-failure
  limit. Network errors and explicitly retryable server errors share this budget. Permanent failures become the feature's visible error state; expired or replaced jobs cannot publish
  results. Mask tracking also recognizes the API's `interrupted` terminal state.
- Media resolution treated authentication, internal, and unexpected failures as successful availability.
  Those failures now set `availability: 'error'`; missing assets and disconnected engines retain their distinct
  states.
- Speech and multicamera preferences spread asserted JSON into typed UI state. Zod now validates each field,
  retains independent valid values, and supplies defined defaults for invalid values. Unknown top-level data
  cannot become a model name, enum selection, or truthy enabled flag. Automatic transcription failures now
  produce an error notice.
- The unused single-scope worker protocol, `createScopeComputer`, and duplicate local scope math formed a
  complete obsolete path. Only their own legacy test imported that math. The live panel already uses
  `createScopesComputer` and the shared project scope implementation. The unused path is removed; readback
  sizing tests remain, with live scope behavior covered by `color-grade.test.tsx` and project `scopes.test.ts`.
- Remotion bundle uploads duplicated chunking and offset recovery. They now call the shared engine client
  `uploadChunks` implementation, including its validated offsets and bounded recovery. Bundle transactions use
  the project `CommandInput` contract so schema defaults remain optional at construction.
- Colour interpretation dialogs duplicated patch generation. Both now use the typed `colorPatchOf` helper.
- Internal command builders now use the project's discriminated `CommandInput` contract, replacing assertions
  against the parsed output type. Partial shape commands
  explicitly omit only the selected clip id. Known clip fields use discriminant/property narrowing instead
  of invented `Record<string, unknown>` interfaces. Overlay host props derive from the existing transform
  overlay contract, and coordinate tuples reuse project `Vec2`.
- Redundant section-divider comments and extraction-obsolete imports were removed. Retained comments explain
  coordinate systems, source-time rules, undo/gesture behavior, browser limitations, or API contracts.

## Decisions and limits

`unknown` remains appropriate for externally supplied JSON, arbitrary composition property schemas, exception
values, and existing open-ended transaction results. These boundaries should be validated or narrowed, not
assigned invented closed types. This pass does not replace project-wide transaction result contracts owned
by the project/session packages.

Worker construction fallback computes the same scopes locally and supports environments without Workers.
Browser storage catches permit preferences to remain usable when storage is blocked. Clipboard access and
browser decoding alternatives handle actual browser capabilities. These are intentional runtime behavior,
not placeholders. Project schema migration and export behavior were not changed.

This is an evidence-based cleanup, not a claim that every remaining assertion or compatibility path is
incorrect or that arbitrary future input can never reveal another bug.

## Validation

- Biome checks on all changed source/test files pass; `git diff --check` passes.
- `audit-web-features.test.tsx` covers permanent lookup failures, bounded transient failures, retry-budget
  reset, interrupted jobs, stale responses, visible tracker failure, same-render duplicate dialog close,
  erroneous media availability, and invalid stored preference types. Preference parsers also have 100-run
  `fast-check` JSON properties.
- A fresh `--maxWorkers=1` run passes all 30 tests in `audit-web-features.test.tsx`, `color-scopes.test.ts`,
  `color-grade.test.tsx`, and `audio-mix.test.ts`. The run took 297 seconds on the shared host; test execution
  itself took 11 seconds. An earlier broad run was stopped after edits changed its loaded modules and is not
  used as final verification evidence.
- The integration owner will run the serialized full web typecheck and the repository verification gate;
  concurrent TypeScript processes were avoided because the shared host was heavily loaded.
