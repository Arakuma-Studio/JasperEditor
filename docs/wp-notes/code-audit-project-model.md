# Project model code-quality audit

## Scope and method

Reviewed the 226 tracked baseline source files in `packages/project/src` outside `commands/` and `registry/`,
with the corresponding project tests.
Commands and registries were audited by separate agents; shared changes were coordinated with their owners.
The review covered type declarations and assertions, import dependencies, duplicate helpers, exception handling,
legacy compatibility, and comments. Targeted implementation research followed the affected call sites, schemas,
render consumers, and existing regression/property tests.

Inputs included `AGENTS.md`, `CLAUDE.md`, the architecture dependency rules, `docs/project-files.md`, the
three-dimensional model and vector-shape workstream notes, and the shipped schema-history tests. No shipped
migration, project schema version, supported project-file representation, media asset, or external dependency
was changed.

A TypeScript AST scan of all project source imports and re-exports excluded type-only edges and computed
strongly connected components. The baseline had four runtime components: shapes/sequence schemas;
roto/index/export/masks; and two command-handler components. This work removes the two model components.
The command audit removes the other two. Public barrel exports remain available.

## Assessment and changes

### Import validation and concrete types

The glTF parser used `Record<string, any>` throughout nested input traversal. Its outer exception conversion
caught some malformed shapes, but invalid values that never threw escaped as supposedly typed model data.
For example, `baseColorFactor: 'red'`, `doubleSided: 'false'`, invalid alpha modes, and short node matrices
were accepted; the short matrix silently lost its transform. Casting those objects to a glTF interface
would hide the same defect.

`three-d/gltf-schema.ts` now validates the renderer's consumed fields and derives the internal document,
node, and primitive types from that schema. Validation identifies the failing property in a `ModelParseError`.
JSON parsing for GLB and textual glTF shares one error boundary. Schema-proven integer checks and duplicate
per-component bounds checks were removed; the accessor's complete byte extent, allocation allowance, and
node-tree depth/uniqueness checks remain. Image caching uses numeric source indices. Valid omitted fields
still use the format's existing defaults.

This is structural validation of the supported static-rendering subset, not a claim to validate every glTF
extension or implement unsupported animation, skinning, sparse accessors, or external-resource loading.
Unknown extension metadata is ignored in the in-memory rendering view; the original imported file is not
rewritten. The existing typed binary/URI error boundary remains necessary for untrusted bytes.

The primary format references used to verify field shapes were the Khronos
[glTF root schema](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/schema/glTF.schema.json),
[node schema](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/schema/node.schema.json), and
[accessor schema](https://github.com/KhronosGroup/glTF/blob/main/specification/2.0/schema/accessor.schema.json).
The Zod schemas were written for this parser's existing subset; no external schema asset or implementation
was copied into the repository.

The hostile-model fixture builder also has a concrete schema-derived type. Tests introduce malformed input
explicitly at the serialization boundary instead of using a blanket `any` document.

### Shared model and metadata definitions

- `Rational` references the schema-derived `RationalT`; this is a type-only dependency.
- Agent schema metadata derives effect, transition, template, text-animation, preset, and property fields from
  their owning types. JSON Schema uses Zod's library schema type. `unknown[]` parameter lists and untyped
  capabilities/settings were unnecessary because their producers already had concrete definitions.
- `rotoMaskCommands` returns the two relevant command input types instead of `unknown[]`.
- Vector property catalogues construct real shape items with the existing defaults. They no longer assert an
  incomplete sample object is a complete `ShapeItem`. Their advertised field types come from `PropertySpec`.
- `resolveLayerProps` accepts the property-bearing portion of a visual clip. Tracking callers provide that
  exact shape instead of asserting incomplete objects are complete `RenderVisualClip` values. Clip feature
  fields use union narrowing instead of double casts.

Unknown input, extension fields, heterogeneous expression results, and generic property traversal remain
`unknown` where validation or interpretation still has to occur. These are deliberate boundaries, not missing
concrete domain types. Shipped migration casts and forward-compatible unknown-clip support were preserved.

### Dependency direction and duplicate implementations

`schema/blend.ts` owns the blend-mode enum/type used by both vector shapes and clips. Sequence continues to
re-export the same public names. This removes the schema cycle and the two lazy wrappers that existed only
to tolerate initialization order; recursive shape-item validation keeps its necessary lazy schema.

`roto/model.ts` owns pure model helpers; its barrel re-exports that module, export checks, and mask conversion.
The latter modules import the model directly, so they no longer import a barrel that exports themselves.

`vector/legacy.ts` owns the pure rectangle/ellipse-to-vector conversion. Lottie export imports the feature
helper directly. The command audit changes the shape handler to consume the same implementation. Conversion
remains supported because these shape representations occur in valid saved projects.

`math/matrix3.ts` owns the row-major tuple and multiplication. Homography and colour-science modules preserve
their public names through aliases; three-dimensional projection consumes the same multiplication; the registry audit uses the same helper for its two copies. Readonly
inputs remain accepted and the output is a concrete tuple without a double cast. Matrix inverses deliberately
remain separate: their singularity tolerances and refusal/fallback contracts differ.

Agent scene and property queries share one metadata-only media-handle builder. Both now supply the complete
handle, including audio presence and rotation; the property-query builder previously asserted an incomplete
object was a `MediaHandle`. Empty URLs are intentional because these queries evaluate metadata without loading
media. Three-dimensional orientation evaluation uses `expressionBindingOf` rather than duplicating the global
symbol and casting through an arbitrary symbol-indexed record.

### Exceptions, compatibility, and comments

The expression-world builder no longer catches every exception from `intrinsicBoxOf` and silently substitutes
a frame-sized box. Its inputs are validated documents and `intrinsicBoxOf` already handles absent media and
nested sequences. Parser errors, invalid regular expressions, malformed caption payloads, and library failure
containment retain their specific boundaries.

The unused command-stub classification was removed from agent schema export in coordination with the command
audit: registered commands advertise `implemented: true`. The API field remains for clients.

Removed 211 obvious section/history comment lines in the scoped source files, plus obsolete workstream labels
and stale lazy-schema explanations. Kept numerical conventions, units, format details, allocation/cycle limits,
license attribution, and reasons for compatibility/recovery behavior. No comments describe this refactor's
history. The colour matrix header now names the two existing attribution records.

## Deliberate limits and recommendations

- Keep older project representations, migration steps, read-time defaults, and unsupported-content retention.
  Removing them as "legacy" would violate project-load compatibility and could lose saved work.
- Do not replace external-input `unknown` with unchecked domain assertions. The glTF change illustrates why
  validation has to precede narrowing.
- PathBool's orientation retry remains a documented numerical workaround. Its second failure still returns
  an empty result. Replacing this with explicit render diagnostics requires an error-propagation contract
  across project geometry and composition rendering; simply deleting the catch introduces a render crash.
  This existing limitation is not claimed fixed by the cleanup.
- Do not combine inverse-matrix routines solely because their arithmetic resembles one another; their failure
  semantics are intentionally different.

## Validation

`three-d-schema.test.ts` was run against the original parser before restoration of the new implementation:
**11 failed, 1 passed**. Failures cover malformed material values, ignored malformed matrices, misleading
boolean values, and a 100-case property test over non-object material inputs. The valid material-default and
unused-extension case already passed. This establishes that the tests detect the original defect.

The focused parser command was:

```sh
pnpm vitest run packages/project/test/three-d-schema.test.ts packages/project/test/three-d-models.test.ts packages/project/test/three-d-hostile.test.ts packages/project/test/fuzz-parsers.test.ts packages/project/test/fuzz-regressions.test.ts --maxWorkers=1
```

Result: **74 passed, 1 failed** across five files. The failure was the unchanged LUT-sniffing fuzz target's
wall-clock allowance: mutation 201 took 3129 ms against a 2000 ms limit under shared-host contention. All new
glTF regressions, hostile-model allocation/tree tests, binary/text model tests, and malformed-input regressions
passed. The retained failing input is in ignored `test-results/fuzz-failures/`; it is not an asset to commit.

Biome checked all 135 changed/new TypeScript files successfully; the subsequent index/media edits passed a
further focused check. `git diff --check` passed. A package typecheck was started and then stopped at the integration agent's
request to relieve shared-host contention; serialized package/global typechecks belong to the integration
gate. No successful typecheck is claimed here until that gate completes.
