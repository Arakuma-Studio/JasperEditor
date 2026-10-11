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

## Independent review of integrated changes

The integration review examined the production changes and regression tests in the area branches,
with particular attention to behavior changed by consolidating helpers or narrowing types. It did
not rerun the owners' test suites; their assessment notes and the integration verification record
contain the execution results.

- The shared export worker scheduler bounds worker/frame allocations, rejects queued and active
  work when a worker fails, handles startup and message-posting failures, and terminates workers on
  close. The extracted frame kernels remain self-contained when serialized into worker source.
- OpenCV adapters use the installed package's declarations. The loader wraps the initialized module
  rather than resolving its self-referential Emscripten thenable directly. The dejudder result union
  preserves the relationship between each operation and its response.
- Project reads validate the envelope and distinguish missing files from corruption and I/O errors.
  Atomic writes continue to synchronize data and the containing directory; only the documented
  unsupported directory-sync cases are suppressed.
- Consequential web actions call `saveBeforeLeaving`, which checks the actual persistence outcome.
  Failed, conflicted, or paused saves cannot authorize navigation, version replacement, or deletion
  of the source recovery journal. Background save scheduling can still report errors through status.
- Upload transport validates initial offsets, chunk sizes, acknowledgement progress, and bounded
  offset reconciliation. Shared transport preserves aborts and retains both the operation and
  cleanup errors when aborting an upload also fails.
- Persisted speech, multicam, and view state now enters through runtime validation. The glTF schema
  validates consumed structural fields while the parser retains its allocation limits. Dynamic
  extension values and untrusted data remain `unknown` until their owning schema or guard checks them.

The independent pass found and delegated four additional corrections:

1. Reading a healthy recovery journal initially called `list`, allowing an unrelated incomplete
   journal to block the read. The engine owner separated direct reads from listing and added a
   regression with healthy and damaged sibling journals. Listing was then extended to return
   per-session warnings alongside healthy candidates; damaged files remain intact. The API, session
   adapter, and both UI entry points carry these warnings together. A warnings-only dialog remains
   visible, and no action offers to discard a damaged journal.
2. The shared job poller initially retried only `NETWORK`. It now also honors the API's explicit
   `retryable` flag, with the same three-consecutive-failure limit. A successful response resets the
   limit; replacement/cancellation checks surround asynchronous requests. Permanent authorization
   and missing-job failures terminate with a visible error.
3. Saved-version readers still asserted `EnvelopeJson` after checking only a few fields. A JSON
   object with a numeric `document` could reach restoration, and missing envelope metadata could be
   persisted. The engine owner reused envelope validation before restoration and added a regression
   asserting that both replacement and copy refuse malformed versions without changing either file.
4. The MCP unavailable-operation hint claimed the command catalog contained `implemented: false`
   entries after the unused stub registry had been removed. The MCP owner changed the hint to refer
   to the current engine/editor capability and tool requirements.

A comment review also caught an orphaned continuation left after deleting the first line of a
historical Lumetri comment. The registry owner retained only the complete parameter-order invariant.
This illustrates why comment cleanup requires reading the remaining prose as well as the diff.

No additional high-confidence regression was found in the reviewed worker, persistence, transport,
or validation changes. This is a scoped source review, not a claim that every possible input or
platform behavior was executed. Compatibility readers, explicit unavailable capabilities, storage
boundaries, and failure-isolating cleanup remain where they protect user work.

### Integrated syntax inventory

An immutable Git-object scan of integration commit `4ff0bd34` applied the same syntax rules to
**1,743 files**. Reading blobs from that commit avoids mixing revisions while other branches merge.

| Candidate | Baseline | Integrated snapshot |
| --- | ---: | ---: |
| Explicit `any` type nodes | 21 | 0 |
| `unknown` type nodes | 2,955 | 2,333 |
| Double assertions through `unknown` | 189 | 102 |
| Catch blocks with no statements | 123 | 110 |
| Simple promise-catch candidates | 194 | 177 |
| Type suppression lines | 0 | 0 |

No file increased its empty-catch or double-assertion count. The new image-loading module's promise
catch was extracted with the existing image decode behavior, rather than introducing a new swallowed
operation failure. Remaining catches and `unknown` values are review candidates under the boundary
criteria above, not evidence that removing them would be safe. The inventory excludes tests and
does not count JavaScript embedded in string literals.

## Final production comment review

A separate pass against integration commit `d45543ed` read residual production comment blocks across
the engine, web UI, project model, compositions, MCP, UI primitives, and native CLI. The largest
remaining concentrations were feature-list headers in web dialogs, workstream narration in engine
imports and rendering, old rendering-stage names, and historical performance anecdotes. The pass
removed redundant headers and section labels and retained concise explanations of constraints:
atomic publication, bounded allocations, sandbox origins, preview/export parity, coordinate spaces,
read-time defaults, recovery preservation, and subscription or rendering costs.

No regular-expression deletion was applied to source comments. Complete surrounding blocks were read
before each edit; protocol details, attribution, compatibility invariants, and useful specification
references remain. Shipped migration behavior is unchanged; its schema-version safety explanation
remains. Registry shader section labels were delegated to the registry owner while that owner checked
shader compilation. Tooling and E2E comments were handled by the tooling owner.

All **180 edited TypeScript/JavaScript files** have identical baseline and edited output from the
TypeScript printer with `removeComments: true`. Template-literal contents remain in this comparison,
including embedded shader and worker code. The native change removes only the obsolete
"Required in M1" sentence from the raw-output option's generated CLI help; the remaining Rust bytes are
unchanged. Whitespace validation is also run. No tests, typechecks, or dependency-graph scans were
started by this pass while integration verification was running.

## Assertion and embedded-code regression review

A final source review compared baseline `12049d8e` with immutable integration snapshot `090431b1`,
concentrating on semantic damage during assertion and comment cleanup. A lightweight TypeScript AST
comparison parsed **1,123 modified production/script files** without starting a compiler, test suite,
or dependency-graph scan. It found no new parser diagnostics and only two new bitwise expressions:

- `Scene3DOverlay.tsx` contained `props.doc | null` after an assertion was removed. Integration
  typechecking had already identified this error; the web feature owner owns the correction and
  regression test. The expression coerces the render document to a number and must not ship.
- `audio-dsp/src/fft.ts` uses `(i >>> b) & 1` in its consolidated bit-reversal implementation. This
  preserves the original algorithm and is intentional.

The review also read 501 candidate diff regions containing removed assertions or prose using
"as", including their replacement expressions. It found no second leftover union/intersection
operator or other high-confidence accidental expression change. Template text changed in 49 files.
The six shader-template changes alter comment text; this observation alone does not establish
semantic equivalence because a consumer may parse that text (see the delimiter review below). The
repaired Premiere common shader has the same interpolation chunks as the baseline. Other template
changes are explicit error messages,
shared-worker protocol changes, intrinsic hardening, or code moved into shared helpers. Their
surrounding implementations were checked rather than treating every textual change as a regression.

This review adds evidence for the specific failure classes encountered during integration. It does
not replace the owners' behavior tests, shader compilation, and final integrated typechecking. No
production code was changed by this pass.

## Source-marker dependency review

Integration exposed a runtime dependency on a removed shader comment:
`packages/compositions/src/three-d/gl.ts` cut `GLSL_BLEND` at
`// ---- effect blends`. Removing that text made `blendSource()` include effect-only functions in
the Classic 3D shader, where their uniforms and varyings are unavailable. The composition owner is
replacing this textual boundary with an explicit reusable layer-blend chunk and a focused rendering
regression. Restoring a section-label comment would preserve the hidden dependency rather than
remove it.

A focused read-only scan at integration snapshot `17c80897` traced source-string slicing, splitting,
replacement, regular expressions, and comment-like string literals across apps, packages, scripts,
and native code. It reviewed 67 comment-like literal matches, 231 index/substring call sites, and
111 source/text/code string-method candidates, followed by their relevant producers and consumers.
No second concrete removed-marker dependency was found. In particular:

- `ported-source:start/end` delimiters remain in both notice generation and the license viewer.
- `anime-allow`, `layers-allow`, and `tokens-allow` directives remain in their lint consumers; no
  active directive was removed by the cleanup.
- Shader uniform extraction uses actual `uniform` lines or identifier mentions, and the checked
  card-shader replacements target retained GLSL statements rather than removed comments.
- Expression-body extraction uses its emitted wrapper syntax; generated worker and motion-graphic
  host scripts do not slice source at removed comment labels.

The earlier AST equivalence check of the final comment-only pass preserved template literal bytes.
The broader audit's separate edits inside template literals require consumer review and rendering
verification as well: comments in generated code can be protocol data. No tests, compiler runs, or
production edits were performed during this focused scan.
