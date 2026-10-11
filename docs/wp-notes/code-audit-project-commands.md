# Command subsystem code audit

Scope: `packages/project/src/commands`, its handler/schema dependencies, and directly corresponding tests.
The assessment uses the checked-in implementation and command schemas, `AGENTS.md`, `CLAUDE.md`,
Architecture §3.1/§5.3, and the graphics and editing performance work-package notes.

## Assessment and recommendations

The command boundary already supplies the essential safety properties: schema validation, immutable
Immer transactions, typed refusals, and invariant checking. Removing these defenses would weaken the
project's recovery guarantees. The main quality problems were inside the boundary: handler modules
imported each other's implementation details, known model fields were accessed through obsolete
`unknown`/`never` casts, and handler-map annotations discarded the precise types TypeScript could infer.

### Dependency direction

The baseline runtime import graph contained two strongly connected components involving commands:
`project` ↔ `process`, and an eight-module component containing `clip-core`, `multicam`, `shape`, `mask`,
`keyframe`, `param`, `sim-warp`, and `structure`. These were real runtime imports, not harmless type-only
relationships. Helpers for construction, lookup, and validation lived beside handlers that depended on
one another.

Implemented: shared leaf modules `project-items`, `clip-common`, `multicam-placement`, `shape-storage`,
`mask-location`, and `puppet-location`. Callers now import the helpers directly. The model audit owns
moving the pure legacy-shape conversion into `vector/legacy.ts`; shape commands use that same conversion.
No serialized fields or command names change.

Measured with a TypeScript AST import/re-export graph and Tarjan's algorithm: zero runtime components
involving command modules after the change, across 516 project modules in this checkout. The graph
excludes type-only imports and re-exports; it resolves local module paths before traversing them.

### Shared types and duplicate implementations

Implemented:

- Handler maps use `satisfies HandlerMap`, retaining the exact implemented keys, argument types, and
  inferred return types. Explicit `unknown` return annotations on concrete handler functions are removed.
- Graphics commands call other handlers directly through those types. The string-indexed dispatcher
  that cast both the command and result to `unknown` is removed.
- Graphics, proxy, channel-routing, and clip patching use the discriminated model types. Clip patches
  narrow the clip kind before writing fields instead of asserting a generic record over the whole clip.
- `DTrack` and clip-effect locations are shared; `SourceFit` derives from its existing schema.
  `CommandInput` exposes `z.input` separately from validated `Command`, so callers can supply fields
  before schema defaults are applied without inventing casts or duplicate command unions.
- Eleven equivalent deep-copy helpers share the same draft-aware JSON clone. The separately used
  shallow Immer snapshot helper remains separate because its aliasing behavior is different.
  Two local animation constructors use the existing `factories.anim`.

The shared clone deliberately preserves the prior JSON-copy semantics, including stripping undefined
object fields. Replacing it with `structuredClone` would change accepted values and fail on Immer
proxies. A generic object-spread copy would alias nested keyframes and mutable payload data.

### Error handling and obsolete paths

Three regressions exposed concrete boundary defects: formatting a command type containing a BigInt
threw outside the command error boundary; a throwing transaction getter escaped validation; and the
keyframe paste resolver hid an unexpected registry exception as a missing-property refusal.

Implemented: non-string command types produce schema errors without serializing hostile values;
a transaction boundary also covers exceptions raised before dispatch and after the draft mutation;
keyframe paste catches only missing/unsupported-property refusals and propagates locks and unexpected failures into the atomic
transaction error result. Every failure keeps the original project reference.

Strongly typing graphic-template import exposed another unchecked edge: its payload was only a generic
record before being cast to a validated clipboard payload. It now uses the existing clipboard parser
and verifies the `project-items` payload kind before insertion. Invalid payloads report a schema error
with the payload path instead of reaching an internal property-access error. Layer pin commands now
reject caption clips, whose schema has Motion but no persisted pin field, before mutating the project.
Other clip variants are narrowed against their actual transform and pin fields.

Unused `notImplemented`/WeakSet stub machinery is removed. The model audit updates schema export to
report the implemented catalog directly. The public `E_NOT_IMPLEMENTED` error-code member is retained:
removing a protocol-level enum member is unnecessary for removing dead executable stub paths.

Removed obvious section dividers, redundant command-array labels, duplicate comments, and historical
milestone/workstream prefixes. Comments explaining timing units, normalization, mutation ordering,
identity caches, geometric invariants, or preservation of unknown project fields remain.

## Changes rejected as unsafe or misleading

- `unknown` at transaction, clipboard, transcript JSON, registry-defined property, and dynamic path
  boundaries is intentional. Substituting a concrete model type before validation would assert trust
  rather than establish it. Heterogeneous transaction results also retain their existing public contract.
- JSON parsing and plugin-schema catches translate hostile-input failures. Synchronization, tracking,
  shape-input, Essential Sound, and time-remap catches translate domain errors into command refusals.
  They have a specific user-visible role and were not mechanically deleted.
- Immer's internal-state probes and documented public-API alternatives protect correctness when its
  private representation changes. They are tested compatibility mechanisms, not discarded legacy paths.
- Headless text measurement, imported offline media, defaults for optional persisted fields, legacy
  shapes still present in saved projects, and unknown future clip kinds remain supported. Removing
  them would alter valid project behavior or lose data. No shipped migration was edited.
- Similar-looking media resolution and animation code was only consolidated where input ownership,
  timing units, validation, and mutation semantics agreed. Visual similarity alone is insufficient.

## Verification

Before the fixes, the three added transaction/clipboard regression tests were run against the original
boundary and catch behavior: all three failed, with the BigInt serialization exception, escaped getter
exception, and hidden registry exception described above.

The final targeted suite and Biome results are recorded after completion below. A package typecheck was
started, then stopped at the integration agent's request to relieve shared-host contention. The final
serialized integration typecheck remains the integration gate; this note does not claim it passed locally.
