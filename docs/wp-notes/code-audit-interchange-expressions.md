# Code quality audit: interchange and expressions

Scope: all source modules and package tests in `packages/interchange` and `packages/expressions`.
The review followed `AGENTS.md`, `CLAUDE.md`, the architecture dependency rules, and the existing
[interchange](interchange.md) and [expressions](expressions.md) workstream notes. It did not inspect
purchased reference material or add dependencies, assets, migrations, or export capabilities.

## Assessment and implemented recommendations

| Finding | Assessment | Implementation |
| --- | --- | --- |
| `jasper-export.ts` and `prerender.ts` imported each other | Export planning depended on execution order across a runtime cycle even though their common information is static. | Moved the capability table into `capabilities.ts`; preserved its existing public export from `prerender.ts`. |
| Acorn AST nodes were `Node & Record<string, unknown>` | The code asserted every accessed AST field and discarded the parser's discriminated node types. Installed Acorn 8.18 exposes `AnyNode`, `Program`, and every node variant in `dist/acorn.d.ts`. | Use Acorn's union directly, narrow by `type`, and retain `unknown` only while inspecting arbitrary node fields. Parsing, completion capture, source positions, and resource limits are unchanged. |
| Snapshot binding replaced known model objects with arbitrary records | Shape branches, masks, effects, and Puppet pins already have shared project types; `as never` bypassed checking their construction. | Bind `Mask` and `EffectInstance` directly, use the render-source union for shape/text branches, and reuse `PUPPET_PIN_PROPS`. |
| Interchange effect/transition parameters were `Animatable<unknown>` | Their writers and readers only support project parameter values; several assignments were forced with `as never`. | Reuse `EffectInstance['params']`, `Transition['params']`, and `Interpolation`; remove unchecked parameter-map casts. |
| Shared primitives and helper implementations had diverging ownership | Frame-rate structure, flicks-per-second, label names, and creation of an empty animatable duplicated existing definitions. | Reuse the project rate, constant, and label catalogue, and the interchange `anim()` helper. Keep interchange-specific frame rounding and unsupported-rate handling local. |
| Export and pre-render code cast discriminated clips to loose records | The complete `Clip` union already identifies optional transforms, masks, effects, 3D properties, and time remapping. | Narrow actual clip fields, type exported entity maps with their project types, and remove double casts around metadata copies. |
| AAF optional reference-table lookup caught every failure | Missing data and corrupted present data were indistinguishable. A non-stream entry named `referenced properties` was silently ignored. | Check whether the optional entry exists, then let malformed present data reach the typed import error boundary. Added a regression covering absence and invalid entry kind. |
| Format detection wrapped already-contained sniffers in another catch | AAF's sniffer already handles hostile binary input; the other sniffers are bounded byte/signature or text checks. The outer catch could hide implementation errors. | Remove the redundant catch, and declare the implemented format registry complete. Keep the public read boundary that turns reader exceptions into `InterchangeError`. |
| Realm hardening silently ignored all intrinsic lookup failures | Most lookups target guaranteed intrinsics in the pinned QuickJS build. Only optional accessor descriptors need an absence check; silently missing another intrinsic weakens isolation. | Collect supported intrinsics directly and check optional `caller`/`callee` descriptors explicitly. Existing initialization error handling reports unexpected failures. |
| Expression transform errors all claimed excessive complexity | A stack overflow is a complexity failure; unrelated failures need their actual diagnostic. | Preserve the catch boundary but report unexpected transform error messages separately from `RangeError`. |
| Unused arguments, dead local computations, and no-op commentary obscured contracts | Several parameters were immediately discarded with `void`; section banners and workstream prefixes contributed no behavior or invariant. | Remove unused inputs and their call-site arguments, a redundant EDL conditional, XML decoder's unused callback, section-only comments, and historical prefixes. Preserve format details, licensing provenance, hostile-input limits, coordinate conventions, and sandbox invariants. |

## Boundaries deliberately retained

- OTIO JSON, format extension metadata, arbitrary template parameters, sandbox arguments/results, and
  reflective property paths remain `unknown` until their consumers narrow or validate them. Declaring
  these values to be trusted project data would weaken the boundary. The project import handler
  validates the opaque fragment using clipboard payload schemas before mutation.
- Catch boundaries around XML/JSON/binary parsing and QuickJS execution still translate malformed
  input and resource exhaustion into actionable errors. The expression compiler's recursion failure
  boundary remains necessary because its bracket precheck cannot bound every possible AST shape.
- Older interchange dialects and alternate producer representations remain supported. These are
  external format compatibility requirements, not unused implementation paths. Unsupported-feature
  reports and pre-render decisions also remain: deleting them could silently change exported output.
- The generic expression value API still supports structured values and selector results. Its existing
  `unknown` contract is broader than `ParamValue` for a reason; no narrower type was invented to hide it.
- Test fixtures use the project's actual solid/text clip, vector shape and media types instead of invented partial shapes and double casts. Command fixture helpers retain `unknown` because they exercise the public validation boundary; unnecessary `as never` casts at that boundary were removed. Generic canonicalizers still accept arbitrary structured values.
- Test comments retain protocol, invariant and measurement rationale; obvious assertion summaries and historical workstream notes were removed.
- No new catch, silent error fallback, placeholder implementation, or explanatory changelog comment
  was added to source code.

## Evidence and validation

Source research used the installed Acorn declarations, the project schema's `Clip`, `Mask`,
`EffectInstance`, `Transition`, `Interpolation`, `Rational`, and label definitions, the render snapshot
source union, the Puppet property catalogue, the compound-file reader's entry lookup/read contracts,
and the import command's validation handler. No external behavior or protocol was changed based on
assumed documentation.

A static relative-import walk after the change found no cycles in either package: 12 expression
modules with 21 relative import edges, and 33 interchange modules with 160 edges. This includes
relative type imports; it does not claim to analyze dynamic imports or the entire monorepo.

- Passed: `pnpm exec biome check packages/expressions/src packages/interchange/src packages/interchange/test/aaf-store.test.ts`, `pnpm exec biome check packages/expressions/test packages/interchange/test`, and `git diff --check`.
- `pnpm exec vitest run packages/expressions packages/interchange --maxWorkers=1`: 185 tests passed, four failed in a 1377.84 s run (689.81 s spent importing). The failures were Vitest's 5 s timeout for the heap/stack test, the ALE throughput budget (5153 ms against an adjusted 2576 ms), and two fuzz-target timing checks (sniffed seed 0: 2005 ms; OMF seed 10/mutation 15: 7814/5762 ms; limit 2000 ms). No result, sandbox-isolation, or round-trip assertion failed.
- The four-test rerun with a 60 s test-runner timeout passed the expression heap/stack test. Three timing assertions still failed: ALE 7436 ms against a calibrated 2766 ms; sniffed fuzz seed 10/mutation 31 took 6515/3216 ms; OMF seed 10/mutation 15 took 4365/2016 ms (fuzz limit 2000 ms). This run took 320.80 s, with 224.42 s spent importing. The fuzz and performance assertions retain their original budgets; these runs do not establish throughput on an uncontended host.
- The AAF corrupt-reference-table regression was run against the reader from `12049d8e` and the changed reader: the original failed with `Missing expected exception`; the changed reader passed. Its two committed regression tests passed in the package run.
- Pending integration: package typechecks were started and then stopped at the integration agent's request to avoid oversubscribing the shared host. The integration agent owns the final serialized typechecks and repository gate.
