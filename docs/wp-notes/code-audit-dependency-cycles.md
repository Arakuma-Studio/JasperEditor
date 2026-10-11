# Dependency graph audit

## Assessment

The package dependency table in `scripts/check-layers.mjs` expresses the intended architecture, but the
original gate did not check cycles between source modules. A legal package graph can still contain cyclic
initialization within a package. Its regular-expression import parser could also interpret comments or quoted
source examples as imports, while missing TypeScript import-type expressions. The forbidden-external patterns
for `@radix-ui/*` and `@fastify/*` required an extra slash after the scope and therefore missed these packages.
Filesystem read errors were caught and treated as empty source directories, which could make a failed scan pass.

A measured baseline scan at `12049d8e` found **1,618 production source modules, 6,035 runtime import occurrences,
and eight cyclic strongly connected components**. The scan used TypeScript 5.9.3 to remove erased imports before
resolving module specifiers. All eight also appeared in an independent syntax-only scan excluding explicit
`import type` / `export type` edges.

| Component | Coupling | Recommended ownership |
| --- | --- | --- |
| MCP `tools/{animation,editing,templates,transitions}` | Tool registrations import shared time arguments from another registration module | Move argument schemas and descriptions below tool registrations |
| Web `commands/mg` and `panels/motionTemplates/TemplateSection` | Registration imports its component, which imports session operations back from registration | Share template upgrade operations through a leaf module |
| Web `mg-bundles/{CompositionSection,CompositionTexts}` | Parent section also owns the generic editor needed by its child | Give `PropEditor` its own module |
| Interchange `jasper-export` and `prerender` | Export conversion and prerender eligibility each own shared helpers | Share format capabilities / expression inspection below both |
| Project handlers `clip-core,keyframe,mask,multicam,param,shape,sim-warp,structure` | Handlers provide reusable editing operations to one another | Extract the shared operations into modules that do not import handlers |
| Project handlers `project,process` | Project settings and media processing share media-locator construction | Move locator construction below handlers |
| Project `roto/{index,export,masks}` | Internal modules import their public barrel | Import shared roto data and functions from a leaf implementation |
| Project `schema/{sequence,shapes}` | Shapes import blend-mode values from the sequence schema that embeds shapes | Define blend-mode values below both schemas |

These findings were delivered to the corresponding source owners. The gate requires all of their integrated
changes to pass; there is no baseline allowlist or cycle exemption.

## Implemented checks

`check-layers.mjs` now uses the TypeScript syntax tree for module references and includes the runtime cycle gate
in the existing `pnpm lint` command. Existing undeclared dependency, public subpath and layer restrictions
remain enforced. Scoped external-package restrictions now match their intended packages. Missing source roots
are allowed, while actual read errors propagate instead of reporting a successful empty scan.

`check-cycles.mjs` discovers production JavaScript and TypeScript beneath every workspace `src` directory, then
follows additional workspace source modules reached outside those directories. It excludes declaration files,
test and fixture directories, and test / spec / benchmark files. It resolves static imports, reexports, literal
dynamic imports, CommonJS require calls and TypeScript import assignments using each package's inherited
compiler configuration, including aliases and package subpaths.

Runtime imports are determined from compiler output, so both explicitly typed imports and imports used only
in type positions are excluded when erased. Inline type imports that preserve module side effects under
`verbatimModuleSyntax` remain edges. Resolution distinguishes `import` and `require` export conditions and
uses TypeScript's implementation-resolution option to avoid following declaration-only `types` conditions;
this behavior is covered against the repository's pinned TypeScript 5.9.3. The SCC traversal is iterative and
reports each participating source edge with its line number.

Desktop may import the shared `@jasper/api` bridge contract through an explicit type-only edge. A runtime API
import still violates its layer. The architecture table records that constraint and session's direct `zod`
dependency for persisted-input validation.

## Verification and limits

The focused suite exercises parser false positives, explicit and inferred type erasure, preserved side effects,
JavaScript-to-TypeScript resolution, inherited aliases, workspace subpaths, conditional exports, CommonJS,
production exclusions, invalid configuration, self-loops and a 20,000-node graph. A property test compares SCC
membership with mutual reachability across 100 generated directed graphs. The layer tests cover scoped-package
restrictions and desktop's type-only edge.

Commands:

```sh
pnpm exec vitest run scripts/check-cycles.test.mjs scripts/check-layers.test.mjs --maxWorkers=1
node scripts/check-layers.mjs
node scripts/check-cycles.mjs
```

**Measured:** the focused run passed 23 tests across two files; the repository assertion was excluded because
its baseline source still contains the eight reported cycles. Biome and `git diff --check` passed.

The existing repository-pass test must run after the eight source fixes are integrated. Baseline execution of
the new gate is expected to fail on those cycles; the focused fixture tests can be run independently with
`-t '^(?!.*the repository passes)'`.

This is a static module graph. Computed specifiers and source code assembled into strings are not inferred.
External packages are resolved to distinguish workspace edges but their implementation graphs are outside the
repository audit. TypeScript's own typecheck remains responsible for unresolved imports and semantic errors.
