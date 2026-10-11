# Project registry code audit

Scope: `packages/project/src/registry`, including effect and transition catalogue families, shader planning and
validation, audio and motion-graphics registrations, and static/dynamic property definitions. This audit changes
code structure and type contracts; it does not change shader formulas, parameter defaults, effect identifiers,
project schemas, or export eligibility.

## Evidence and assessment

The audit inspected the registry sources, their consumers in the project/render/colour model and compositions,
and the relevant tests. The governing references were `AGENTS.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`,
`docs/wp-notes/fx-shader-framework.md`, and `docs/wp-notes/fx-transition-framework.md`. The authoritative value
and structure types are in `schema/common.ts`, `schema/three-d.ts`, `schema/text-animators.ts`,
`puppet/model.ts`, and `gaps/warp/analysis.ts`.

### Repetition and shared types

The effect families copied the same finite-number, boolean, string, and clamp implementations. These copies
added maintenance work without encoding family behaviour. A measured 49 equivalent scalar implementations
now use `registry/param-values.ts`. Existing family exports still resolve to the shared functions so catalogue
consumers do not need separate adapters. The numerical/default behaviour is unchanged.

The same media-parameter shape was repeatedly asserted as `{ mediaId?: unknown }`, even though `ParamValue`
already defines `{ mediaId: string }`. `mediaParamId` now narrows the union structurally and checks the property
before returning an identifier. Effect planning, transition planning, temporal dependency checks, keying,
colour-input transforms, and media-dependent family passes use this reader. The compositions audit consumes the
same public helper through the project index.

Internal effect helpers accepted `unknown` or `Record<string, unknown>` after their inputs had already been
resolved to effect parameters. They now accept `ParamValue | undefined` or `EffectParams`. The distinction
between an absent value and a finite scalar remains explicit. The shader context now carries `ResolvedPuppet`
and `WarpAnalysisData` instead of erasing these model types and forcing every consumer to assert them.
Text animator property lookup uses the catalogue's existing key union directly. The 3D property predicates use
`Layer3D` and `LightData`, including the light-type union. Property value kinds and family slider ranges reuse `ParamSpec`'s definitions.

The colour-space and distortion families each had the same row-major matrix multiplication and an unsafe
`number[] as unknown as Mat3` assertion. They now consume `math/matrix3.ts`, shared with model/render/colour
consumers by the model audit. The registry aliases preserve their existing readonly matrix contracts.

Recommendations implemented: share identical scalar semantics; reuse established model types; share matrix
multiplication; centralize media-parameter narrowing; keep numerical coordinate conversions family-specific.

### Similar code that has different contracts

Vector readers differ in required length, per-component defaults, and whether a malformed component replaces
the whole vector. Sapphire size conversions differ by family: half-width units, width-relative Gaussian sigma,
and height-relative blur reach are all present. Matrix inverses also differ: some return `null` on singular
input, while the colour conversion's fixed-gamut helper uses the identity. These are observable contracts.
Unifying them mechanically would alter frames or error behaviour, so they remain distinct.

Effect and transition validators share six GLSL syntax rules through `fx/validation.ts`. Their additional rules
remain separate: effect validation checks nondeterministic code references, while transition validation forbids
redeclaration of its side samplers. Pass-output names, side-placement texture accounting, and transition-specific
parameter restrictions remain with their respective frameworks.

### Error handling and regression

The GPU validators catch failures from effect/transition hooks and report catalogue errors. Those catches are
necessary: validation must report an invalid entry rather than crash. However, four catch handlers asserted every
thrown value was an `Error`. Throwing `null` or `undefined` caused a second exception while constructing the
error report; strings and numbers lost their diagnostic value. The handlers now narrow `Error` and stringify
other thrown values. `registry-validation.test.ts` reproduces both hook locations for both registry kinds.

Measured before the fix: the regression file had 8 failures and 2 passes; the failures included a `TypeError`
when reading `.message` from `null`/`undefined`. After the fix: all 10 cases pass.

The integrated software-GL compile gate found an audit regression in `defineEdgeWipe`: two template
interpolation expressions had lost their braces during the scalar-reader edit. Generated shaders contained
literal JavaScript fragments for border width and the wipe body. Both expressions now match the baseline.
`transition-edge-wipe.test.ts` checks the planned shader body and border declarations with borders enabled
and disabled; both cases failed before this fix. A complete registry diff scan found no other added
`$identifier` interpolation corruption.

Seven catches remain in the registry. Four isolate author-provided GPU hooks and return validation diagnostics.
The other three isolate stored stabilization analysis, custom OCIO transform construction, and conversion of
external motion-graphics Zod schemas to property metadata. Removing those boundaries would turn unsupported or
malformed external data into render/editor exceptions. Their existing preview defaults are intentional: the
Warp Stabilizer and colour-input export planners separately refuse missing or unsupported render dependencies.
Changing their diagnostics would require a coordinated UI/planner contract rather than deletion of a catch.

### Remaining boundary types and compatibility

A measured TypeScript AST scan of the final 205 registry files found no explicit `any` type nodes and 71
`unknown` type nodes. Remaining unknowns are concentrated in dynamic property/JSON-schema inspection,
motion-graphics template payloads, migrations, and raw property/command values. These locations accept data
whose shape is established by a schema or property definition at runtime. The two mesh readers retain `unknown`
because they validate serialized mesh layouts before commands and rendering use them. Replacing these types
with an asserted application type would hide the boundary rather than make it safe.

Evaluated colour effects now require `EffectParams`, and registry-default resolution accepts typed parameter
values with explicit missing/null defaulting. The stack partitioner has an actual additional caller with
persisted `Animatable<ParamValue>` parameters (`apps/engine/src/color/extension.ts`); its generic constraint
therefore covers only the effect metadata it reads. It does not weaken the evaluated parameter contract
used by colour baking and cache keys. The grading service builds typed evaluated parameters before default
resolution, without an `unknown` cast.

Old effect parameter migrations and registry version lookup remain necessary to open saved projects. Named
M1/M2 catalogue arrays remain exported composition groups, not alternative implementations. Unknown effect
preservation, absent media handling, and resource/offline rendering defaults also remain because the project
format and no-data-loss rules require them. No placeholder implementation was promoted to a completed feature.

### Dependencies and comments

A TypeScript AST import/export graph scan across `packages/project/src` excluded type-only edges and inspected
strongly connected components containing registry modules. It found no runtime dependency component containing
a registry module. Shared readers and GLSL validation rules are dependency leaves; the new model structure
references are type-only imports. Family imports continue to avoid importing registry values back from
`effects.ts`.

A measured 378 section-label comments were removed, along with redundant helper descriptions, catalogue-row
labels, and development-wave/workstream history. Comments that describe GLSL protocols, coordinate systems,
non-obvious mathematical conventions, singularity handling, bounds, and licensing provenance remain. The blend
comment now describes the actual effect-versus-clip formula distinction without change history.

## Verification

- `pnpm exec biome check packages/project/src/registry packages/project/test/registry-validation.test.ts`:
  passes after formatting.
- `pnpm exec vitest run packages/project/test/registry-validation.test.ts --maxWorkers=1`:
  10 tests pass, following the failing-before-fix run described above.
- `pnpm exec vitest run packages/project/test/fx-*.test.ts packages/project/test/transition-*.test.ts
  packages/project/test/properties*.test.ts packages/project/test/three-d*.test.ts
  packages/project/test/text-animators*.test.ts packages/project/test/registry-validation.test.ts --maxWorkers=1`:
  34 of 35 files pass; 460 of 462 tests pass. The two failures are in the unchanged `three-d-hostile.test.ts`:
  a glTF allocation refusal took 151,164 ms against its 20,000 ms wall-clock budget, and another hostile-model
  test exceeded its 60-second timeout. The run took 1,259 seconds, including 848 seconds of imports. These
  timing failures are consistent with the observed shared-host contention; serialized integration verification
  must rerun that file before claiming a passing gate. The registry, shader, transition, property-consuming 3D,
  and text animator behavioural tests passed.
- An isolated rerun of `three-d-hostile.test.ts --maxWorkers=1` passed 12 of 13 tests in 84.52 seconds.
  The same glTF allocation-refusal timing assertion remained over budget (43,885 ms versus 20,000 ms); its
  error result was correct and the other previously timed-out test passed. The performance gate remains
  unresolved and no timing limit was changed.
- After narrowing evaluated parameters, the existing colour/default-resolution checks passed:
  `pnpm exec vitest run packages/project/test/color.test.ts packages/project/test/lumetri-grade.test.ts
  --testNamePattern='defaults|registered' --maxWorkers=1` (2 files, 5 tests passed, 43 unrelated tests skipped).
- Package typechecking was started, then stopped at the integrator's request because simultaneous project
  typechecks were exhausting shared-host resources. Final serialized typechecking is an integration gate.
- `git diff --check` is run before commit.

Integration dependencies: merge the model audit's `math/matrix3.ts` and public `mediaParamId` export and the
compositions audit's typed structured-effect readers with this change. The evaluated-effect narrowing also
requires the model audit's metadata-only `effectRuns` constraint and the engine export audit's typed grading
parameter construction. A temporary local link to the model
agent's matrix helper was used for tests; that link is not committed. No assets or dependencies were added.
