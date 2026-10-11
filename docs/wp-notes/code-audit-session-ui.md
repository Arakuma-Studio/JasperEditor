# Session and UI code-quality audit

Scope: `packages/session` and `packages/ui`, including their tests and the session benchmark. The audit compared
production code with `AGENTS.md`, architecture §§3.1/6, `docs/project-files.md`, the reload-lease explanation in
`polish.md`, actual API schemas, timeline view consumers, and installed TypeScript DOM declarations.
No assets or external source code were introduced.

## Assessment and implemented recommendations

- **Persisted views crossed a trust boundary through assertions.** The engine deliberately treats view JSON as
  opaque; the session cast its `views` to partial sequence views and dereferenced `tabs.open`. A malformed view
  could throw during opening or deliver invalid zoom/nested records to the timeline. Session-owned Zod schemas now
  validate this boundary and define both shared view types. Invalid view settings produce `W_REPAIRED` and reset
  only view state; the project document remains intact. Existing partial sequence views remain accepted. Negative
  horizontal scroll is valid: the timeline uses it for left padding (`model/viewport.ts`), so it is preserved.
- **Runtime type assertions concealed malformed protocol details.** Revision conflicts and held-lease details now
  use their existing API schemas instead of fabricated `-1` revisions or `unknown` lease holders. An invalid error
  payload remains an `EngineError`. BroadcastChannel probes/claims are validated before use; outbound messages
  have a finite union type, and lease storage is parsed through its schema.
- **Several types were unnecessarily weak or duplicated.** Gesture timers use actual browser/Node handles;
  lifecycle targets and idle callbacks use DOM declarations; the dialog registry no longer uses `any`; primary
  dialog actions state their boolean/void contract; UI RGBA tuples reuse the project type. Test fetch implementations
  satisfy `typeof fetch`, and the fake engine validates requests with real protocol schemas. Other casts were
  removed where discriminated unions or existing properties already carry the type.
- **Cloning unnecessarily passed through untyped JSON.** The in-memory store now uses `structuredClone` for detached
  snapshots. Engine Save As uses an immutable shallow replacement of the project id/name because nested document
  data is unchanged and immediately serialized. No user document mutation is introduced.
- **Error handling failed at actual UI boundaries.** A panel throwing `false`, `0`, or an empty string made its error
  boundary render the broken child again. Boundary state now contains `Error | null`, with arbitrary thrown values
  normalized at entry. Clipboard failures are shown in the panel; failed dialog primary actions remain open with
  an accessible error; eyedropper cancellation remains quiet while other failures produce a toast. Rejected pointer
  lock requests clear the lock flag so pointer cancellation is still handled.
- **Number formatting had an avoidable render crash.** `formatNumber` forwarded an unbounded precision to
  `toFixed`, which throws above 100. Rounding and formatting now share the same finite, integral 0–10 precision.
- **Unsupported/legacy branches overstated capabilities.** `ProjectStore.importFile` now accepts the file contents
  actually supported by every implementation and caller (`Blob`); the unused desktop-path placeholder is gone.
  Invalid runtime arguments receive `BAD_REQUEST`. Recovery no longer permanently stops after an obsolete engine's
  `NOT_IMPLEMENTED` response: failures stay reported and use the existing bounded retry interval.
- **Comments mixed implementation history with useful constraints.** Removed obvious section headings, repeated
  style/function descriptions and workstream/history narration. Retained ownership, protocol, cancellation,
  performance and persistence invariants; shortened explanations of modal keyboard ownership and tab lease memory.

## Boundaries deliberately retained

`unknown` remains appropriate for unparsed JSON, received browser messages, arbitrary thrown values, and the open
string-keyed dialog registry. The first three are validated/narrowed at entry. Replacing them with assertions would
weaken safety. Dialog registration is an extensibility boundary: defining every application dialog inside the UI
package would reverse the dependency direction. Property-test command generators intentionally exercise runtime
validation, and command result types are owned by `@jasper/project`.

Storage access, network/lease operations, journal persistence, pointer capture/lock, and browser permissions can
fail independently of TypeScript types. Their catches serve specific recovery or reporting roles and remain.
The recovery writer and autosaver have different eligibility, durability, deletion and retry rules; merging them
into one generalized queue would obscure these invariants. Incremental serialization, lease aliases, tab takeover
probes, revision conflicts and conservative document loading remain intact.

The repository-wide dependency audit measured no runtime import cycle involving session or UI. The new schemas
are leaf modules; shared type reexports add no runtime cycle. The architecture's dependency table records Zod as
a direct session dependency; integration refreshes the lockfile.

Autosave/journal `flush()` report failures through status/callbacks and may resolve while saving is paused.
Destructive navigation/recovery consumers must inspect durability after flushing. The web audit owns those call
sites and their regression tests; this change preserves the established session API semantics.

## Validation

New regressions cover malformed persisted views, nonpositive/nonfinite zoom, retained negative scroll, arbitrary
JSON view records (200 property runs), falsy thrown panel values, clipboard failures, failed dialog actions and
out-of-range numeric precision (200 property runs). Existing session suites exercise undo/redo, leases, autosave,
crash recovery, gesture performance and integrity across random edits; existing UI suites cover primitives/menus.

Biome passed for both packages. Focused tests are pending in this commit; the initial worktree run was
restarted after linking the newly declared Zod dependency into its local dependency tree.

Focused verification command: `pnpm exec vitest run packages/session/test packages/ui/test --maxWorkers=1`.
The root-project focused run was stopped while propagating the integration recovery-warning contract.
Package typechecks and the final full gate are run serially by integration because parallel TypeScript workers
exhaust the shared host. No visual layout changes are intended; failure messages are covered by DOM assertions.

## Recovery-list integration

`RecoveryStore.listRecovery` now returns the shared API `RecoveryListResponse` rather than discarding everything
except its candidate array. Engine warnings about unreadable individual journals survive the session adapter;
the in-memory store returns the same shape with no warnings. The web audit displays these warnings alongside
healthy recovery candidates. Engine recovery retains the damaged bytes for a later repair.
