# API and engine client audit

Scope: every source module in `packages/api` and `packages/engine-client`, their tests, and the producers and
consumers needed to establish contract ownership. Dependency rules: `docs/ARCHITECTURE.md` §3.1. Safety rules:
`AGENTS.md` §0. Installed Zod 4 schemas and TypeScript's fetch declarations are the implementation references.

## Critical assessment

- `parseEvent` assumes any key found on `EVENT_PAYLOADS` is a schema. Inherited names such as `constructor` and
  `__proto__` violate that assumption and throw on an untrusted event. Check own membership before indexing and
  add regression and property coverage.
- The API repeats the project's rational schema and several registered-media response shapes are opaque records.
  Reuse the project's rational fields while retaining the HTTP object's existing unknown-key stripping, and use
  `RegisteredMediaSchema` for relink and media-job outputs. Document change origin already has a canonical schema
  in `TransactionSchema.shape.origin`. Preview settings and camera tracking settings/points reuse project schema
  fields. Roto strokes retain the wire allocation cap while sharing model fields; mask and roto tracing share
  their exact result schema.
- Desktop preload and web runtime independently define the same IPC bridge and disagree about nullable
  capture/MCP responses. A type-only `desktop.ts` contract records the actual main-process return values. The
  desktop and web owners adopt it; the dependency audit permits the explicit type-only desktop-to-API edge.
- Client response wrappers cast valid inferred results to their existing type or even cast request bodies to
  `never`. These assertions add no safety and are removed. JSON calls also reject non-JSON routes before sending
  a request instead of returning JSON-null with a `never` assertion. Client network error wrapping is duplicated and
  casts caught values to `Error` without checking them; use one checked error conversion.
- Upload implementations repeat chunk iteration, trust server offsets to make progress, and use a chunk-size
  fallback despite the response schema requiring a positive size. Consolidate the loop, reject offsets outside
  the blob or acknowledgements that do not match the submitted chunk, and preserve explicit offset-conflict
  recovery. Cancellation cleanup must preserve both an original failure and a failed cleanup rather than hide
  the latter.
- Event stream state-change information repeats one type. Define it once. Event parsing catches malformed JSON at
  the network boundary; reconnect catches transport failures. Both have real error-handling roles and remain.
- `ExportSettings.video.colorTags` is a legacy constant with no readers: `rg -n colorTags apps packages` found
  only its schema and object-literal writes. `colorSpace` controls output color. The schema field is removed;
  the integrator removes producer/test literals across owners. Old callers may still send the field because
  the HTTP object strips unrecognized properties. Project documents and migrations are unaffected.
- `RouteOwner` and route `owner` fields have no consumers in the repository. These workstream labels are
  historical metadata, not routing behavior, and are removed.
- File banners, section separators and workstream/history labels are widespread. Remove redundant banners and
  labels while keeping protocol details, units, safety constraints and explanations of non-obvious behavior.

## Contract boundaries and recommendations

`unknown` is required for data not yet validated: heterogeneous job results, agent query/relay payloads,
schema-driven template props, migration-capable project documents and error details. Substituting assertions or
a narrower fake JSON type would conceal these boundaries. Named result schemas should be used where the producer
has one fixed result. Persisted envelopes must reach the migration/repair loader without imposing the current
document schema prematurely.

The packages contain no internal dependency cycles: schema modules point toward project definitions and the
client depends on API contracts. The registered-media replacements must import `media.ts` directly. Project
origin and job origin have different wire formats and must not be merged. HTTP rational objects strip extras;
project rational objects preserve extras for lossless loading, so sharing the fields preserves both policies.

The public `EngineClient.uploadChunks` helper accepts a validated upload session, enforces byte-offset progress,
and handles bounded conflict recovery. `uploadFile` and `uploadSequenceFrame` share it.

Consumers outside this scope include the separate bundle upload loop in `apps/web/src/mg-bundles/import.ts` and
casts of relink/media-job results. Their owners can adopt the client upload helper and strengthened API results.

## Verification

- A TypeScript AST inventory of 39 source modules measured zero explicit `any` type nodes, ten explicit `unknown`
  type nodes, and no internal runtime dependency cycles. The unknowns are raw JSON, caught errors, extensible
  error details, and the low-level request body; schema-level opaque payloads remain at the boundaries above.
- `pnpm exec biome check packages/api packages/engine-client` passes.
- `pnpm vitest run packages/api/test/api.test.ts packages/engine-client/test/client.test.ts --maxWorkers=1`:
  final run passed 24 tests in two files, including the non-JSON-route regression (228.92 seconds on the shared
  host, 1.28 seconds in tests).
- Package typechecking was started and then stopped at the integrator's request to relieve shared-host CPU
  contention. The integration gate runs serialized typechecks for these packages and their consumers.
- Regression coverage rejects inherited event names and fuzzes arbitrary JSON/event names. Upload coverage checks
  non-progressing, partial and oversized acknowledgements; out-of-file conflict offsets; cleanup failure reporting;
  sequence-frame offset recovery; invalid chunk sizes; and existing cancellation/chunking behavior.

No assets, runtime dependencies, persisted document formats, or migrations changed.

## Recovery-list diagnostics

Recovery listings expose per-journal `{sessionId, code, message}` warnings beside healthy candidates. The shared
`RecoveryJournalWarning` and `RecoveryListResponse` contracts carry those errors through engine validation and
the client rather than letting the response parser discard them. Omitted warnings parse to an empty list, so
clients can also consume engines that do not provide this additive field. The engine and session/UI owners
implement journal isolation and warning presentation; the API contract regression verifies that candidates and
warnings survive together and that omitted warnings remain compatible.
