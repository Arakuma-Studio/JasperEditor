# Code audit: independent crosscut review

This review inspected the baseline at `12049d8e` independently of the area audits. It identifies
cross-area problems and distinguishes removable scaffolding from compatibility and failure handling
required by `AGENTS.md`. Production changes belong to the corresponding area audit; this note does
not claim those changes have passed integration until their implementation and regression tests do.

## Method and measured inventory

The review read `AGENTS.md`, `CLAUDE.md`, the architecture and dependency rules, `docs/gaps.md`,
`docs/parity.md`, `docs/project-files.md`, and the code and callers cited below. Searches used tracked
paths or ripgrep's ignore rules. No purchased reference files or assets were inspected.

A TypeScript 5.9.3 syntax-tree walk inspected **1,700 tracked TS/JS production and script files** under
`apps`, `packages`, `scripts`, and `native`. Files under `test`, `tests`, `__tests__`, or `bench`, and
files named `*.test.*`, `*.spec.*`, or `*.bench.*`, were excluded. Counts are measured syntax nodes,
not counts of defects:

| Candidate | Baseline count | Interpretation |
| --- | ---: | --- |
| Explicit `any` type nodes | 21 | Concentrated in OpenCV adapters, registries, and worker dispatch |
| `unknown` type nodes | 2,955 | Includes essential parser, dynamic-property, and thrown-value boundaries |
| Double assertions through `unknown` | 189 | Review the actual type relationship and caller before replacing |
| Catch blocks with no statements | 123 | Includes documented storage, cleanup, and capability boundaries |
| Promise catches returning an identifier/null or an empty block | 194 | Includes cleanup and promise-chain continuation; not all are swallowed operation failures |
| `@ts-ignore`, `@ts-expect-error`, or `noExplicitAny` suppression lines | 0 | No such production/script suppression was found |

The inventory can be reproduced by taking `git ls-files apps packages scripts native`, filtering
paths as described, parsing each file with `ts.createSourceFile`, and walking with `ts.forEachChild`.
Count `AnyKeyword`, `UnknownKeyword`, nested `AsExpression` with an inner `UnknownKeyword`, and
`CatchClause` blocks with zero statements. Promise-catch candidates are calls whose property name
is `catch` and whose function body is an identifier, `null`, or an empty block. These rules do not
claim to detect equivalent control flow or code embedded inside template strings.

The 21 explicit `any` nodes were in:

- `apps/engine/src/camtrack/{features.ts,worker/run.ts}`;
  `tracking/{mask.ts,planar.ts,point.ts,warp.ts,worker.ts}`;
  `roto/worker/run.ts`; and `processing/proc/dejudder/pool.ts`: 14.
- `packages/mg-templates/src/types.ts`: 3 heterogeneous template-registry aliases.
- `packages/compositions/src/mg-host/remote.ts`, `packages/project/src/three-d/gltf.ts`,
  `packages/ui/src/dialog/Dialog.tsx`, and `scripts/perf/ui-scenarios.ts`: one each.

A separate Rust search found no production `todo!`, `unimplemented!`, or `panic!` path. The template
registry's `expect("defaults serialize")` calls serialize locally constructed parameter defaults;
Cargo build-script `expect` calls report build failures. Neither is equivalent to asserting the
shape of untrusted renderer input. Rust test assertions are outside the production inventory.

## Findings requiring behavior changes

### Saving must prove durability before navigation, restoration, or recovery cleanup

`packages/session/src/persistence/autosave.ts` catches a store-write failure, records it in status,
and resolves its `save()` promise. It also resolves without saving when paused by a conflict or lost
lease. `flush()` awaits that promise. Similarly, `persistence/recovery.ts` reports a journal-write
failure but resolves. These are reasonable background scheduling boundaries, but `Promise<void>`
does not mean the current document is durable.

Three callers treat completion as success:

1. `apps/web/src/shell/engine-dialogs.tsx` awaits `beforeLeave` with a catch that returns `undefined`,
   closes the dialog, and navigates to another engine. `commands/polish.ts` supplies a persistence
   flush. The dialog says unsaved changes are saved first, but a failed or conflicted save does not
   prevent navigation.
2. `apps/web/src/home/project-files.tsx` applies a recovery snapshot, flushes the new journal and
   autosaver, and deletes the source recovery journal. Both writes may fail while resolving, so the
   only durable recovery copy can be deleted.
3. The same file's version-restoration action flushes before replacing the stored project and
   reopening it. A failed flush means the engine's before-restore backup cannot contain the current
   unsaved screen state.

**Recommendation:** expose or check the persistence result at these consequential callers, including
paused/conflicted saves. Preserve the source recovery journal unless the recovered revision is
confirmed durable. Report the reason in the existing dialog or notice and keep the session available
for retry. Removing the outer catch alone is insufficient because the underlying flush resolves on
failure.

**Required regressions:** failed save and revision conflict prevent engine navigation; failure of both
journal and project writes preserves the source recovery journal; failed save prevents version
replacement. Tests should exercise the real autosaver result semantics, not only a mock that rejects.
These findings were sent to the integration agent for the session and web-shell owners.

### Polling must distinguish transient failures from lost jobs

`apps/web/src/tracking/actions.ts`, `roto/actions.ts`, `three-d/camtrack/actions.ts`, and
`masks/actions.ts` retry every `getJob` exception indefinitely. `JOB_NOT_FOUND`, `NOT_FOUND`, and
authorization failures cannot be repaired by silently polling the same identifier. The UI retains
its running state, contrary to the rule that a dead worker or engine must not leave work running
forever.

**Recommendation:** share the classification of retryable transport failures and terminal job lookup
failures. Terminal failures must clear the running state and report an actionable error. Any retry
bound should measure repeated lookup failures, not the duration of a valid long-running job. Preserve
cancellation races and event-stream completion guards. Test a permanently missing job and recovery
from a transient network error.

`apps/web/src/processing/engine-jobs.ts` already provides `followJob`, but its immediate rejection on
any lookup failure differs from these retrying loops. Consolidation must choose and test the intended
policy; merely routing all callers through one helper can change resilience.

### Media-resolution errors must not report successful availability

`apps/web/src/import/media-runtime.ts` handles missing assets and network failure explicitly, then
marks every other failed status lookup `online` under an older/stub-engine compatibility branch.
An unauthorized request, server error, or invalid response therefore appears successful. The batch
lookup also retains a missing-batch-route compatibility path.

**Recommendation:** represent unexpected lookup failure as the existing error state and preserve its
diagnostic. Remove obsolete old-engine branches only after confirming the supported API contract and
updating tests that intentionally fake missing routes. A missing asset and a temporarily disconnected
engine still need their distinct states.

### JSON assertions do not validate saved preferences

`speech/auto.tsx::loadAuto`, `speech/model.ts::loadOptions`, and `multicam/state.ts::load` in the web
app assert parsed JSON as `Partial<T>` and spread its fields over defaults. The multicam loader checks
layout but not its booleans. Values such as `enabled: "false"` or `model: {}` survive the assertion.
A `try`/`catch` catches malformed JSON syntax; it does not reject valid JSON with the wrong shape.

**Recommendation:** parse as `unknown` and validate each persisted field with the package's existing
schema conventions, retaining defaults for invalid values. Test malformed JSON, wrong primitive
kinds, and a partially valid object. Keep catches for unavailable/quota-limited storage. The
three-dimensional view store already validates camera vectors and view membership; preserve that
boundary while improving its input types.

### Filesystem failures should retain their cause

`apps/engine/src/tools/fs.ts::readJsonOrNull<T>` trusts a caller-selected generic type and converts
all read/parse errors to `null`. `projects/store.ts::readEnvelope` then reports `PROJECT_NOT_FOUND` for
corruption and permission/device failures. `ProjectStore.list` returns an empty list if the projects
directory cannot be read and silently skips every unreadable project. These policies keep the engine
alive but can conceal the reason users cannot see their work.

`fsyncDir` also suppresses every directory-sync failure to support platforms that cannot fsync a
directory. The unsupported-platform case and a real durability failure have different meanings.

**Recommendation:** distinguish expected absence and unsupported operations from permission, device,
and malformed-data errors at the store boundary, using the engine's typed error format. Keep files
intact. Narrowly classify unsupported directory-sync cases without weakening atomic writes. Any
change requires injected filesystem-failure tests because the save contract is safety-critical.

## Consolidation and removable scaffolding

`packages/project/src/commands/handlers/util.ts` defines `notImplemented`, its `STUBS` weak set, and
`isNotImplementedHandler`. A repository search finds **no call to `notImplemented`**. The only other
production consumer is `agent/schema-export.ts`; the transaction test checks the predicate. This is
unused milestone scaffolding, not a capability boundary. Remove the factory and predicate, preserve
explicit handler-catalog completeness tests, and report the actual registry as implemented. Do not
mechanically remove `NOT_IMPLEMENTED` from protocols: unavailable engine/session capabilities have
separate callers and error contracts.

`packages/project/src/schema/common.ts` exports the canonical `[number, number]` `Vec2`. Exact aliases
occur throughout web shape, monitor, effect-overlay, roto, motion-graphic text, warp, and camera
tracking code. Reusing that type requires no new dependency and avoids duplicate ownership. Exported
web aliases can re-export it when needed to keep local APIs stable. The identical
`Pick<EngineClient, 'call' | 'getJob' | 'cancelJob'>` types named `TrackingEngine`, `RotoEngine`, and
`CamTrackEngine` are another candidate alongside shared polling.

Do not combine types only because their names match. `Rect` describes different coordinate contracts
in project transforms (`x/y/width/height`), UI placement (`left/top/right/bottom`), and scopes
(`x/y/w/h`). Those need explicit conversion, not a common alias. Byte-formatting helpers also differ
in accepted missing values and precision; consolidation should first choose the intended presentation.

For OpenCV, use the installed package's types or a checked adapter for the subset actually available
in the bundled worker. Avoid a hand-written interface that hides package/runtime differences. For
heterogeneous template or dialog registries, contain type erasure at registration and preserve the
relationship between each entry's schema, props, and render function. Replacing `any` with a cast to
an unrelated generic type is not stronger typing.

## Boundaries and compatibility that must remain

The audit should not target a zero-`unknown` or zero-`catch` count:

- Project files, HTTP/event payloads, imported JSON/schema data, worker messages, extension props, and
  thrown JavaScript values are untrusted until checked. `unknown` expresses that obligation; assertions
  or falsely precise generic return types can remove it without adding safety.
- Heterogeneous effect parameters and expression values need registry-based narrowing. A union must
  preserve the supported formats and extension values rather than rejecting them incidentally.
- Browser storage, unavailable capabilities, process termination, and cleanup can fail independently
  of the operation. Preserve boundaries that prevent crashes, isolate providers, retain a primary
  error, or keep a queue usable after a rejected job. Make meaningful failures visible at the owner.
- Project migrations and legacy text/shape representations remain active compatibility paths.
  `docs/project-files.md` requires shipped fixtures to keep loading and forbids editing shipped
  migration steps. Removing those paths is data loss, not cleanup.
- Alternate file-format readers, missing-media placeholders, hardware/software encoder selection,
  and exact render-path selection are active behavior. A branch called a fallback is not automatically
  deprecated. Any export alternative must retain preview parity or refuse with a named blocker.
- The Prism Lens and Pixel Mosh effect comments describe explicit unsupported parameter groups and
  algorithm limits. Removing such disclosures would hide limits; implementing new effect behavior is
  a separate fidelity task. The absence of a `TODO` does not prove completeness.

## Comment assessment and dependency verification

There is substantial workstream/milestone narration in production comments, including obvious section
labels, feature-ticket prefixes, and statements about previously slower implementations. Remove
narration when surrounding code supplies the same information. Retain the actual invariant when a
historical comment also explains an architectural constraint: avoiding two autosavers racing on
`If-Match`, exact shader units, reference-frame semantics, GPU allocation bounds, stable cache keys,
and licensing/protocol restrictions are useful information that a reader cannot infer from a symbol
name alone.

Do not delete comments or error handling by a repository-wide keyword replacement. Words such as
"removed", "legacy", "placeholder", and "fallback" frequently describe current behavior rather than
history. The inventory deliberately treated those matches as candidates for reading, not edits.

The existing `scripts/check-layers.mjs` checks package-layer imports and declared exports. Running
`node scripts/check-layers.mjs` on the baseline passed (`check-layers: ok`). This gate is not a
file-level circular-dependency detector; the dependency audit
must separately distinguish runtime imports, type-only edges, and genuine strongly connected
components. Breaking a type-only cycle by moving unrelated types into a global utilities package
would increase coupling rather than reduce it.

## Validation and scope

The syntax inventory and caller research above are read-only measurements of the baseline. No production
code or tests were changed in this crosscut branch. Findings were delegated to the owning audit branches
to avoid conflicting edits. Integration must record their final implementation, tests, full verification,
and any unresolved limitations; these counts alone do not establish that every code path is correct.
