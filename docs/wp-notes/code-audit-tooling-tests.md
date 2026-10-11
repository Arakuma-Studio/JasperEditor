# Tooling, E2E and testkit code audit

Scope: root tooling configuration, `scripts/`, `e2e/`, `packages/testkit/`, and generated-fixture source.
The dependency-layer checker and its tests belong to the dependency-cycle audit. Generated media, golden
references, attribution records and third-party binaries were not changed.

## Critical assessment and recommendations

The strongest duplication was at test boundaries: browser API declarations, transaction outcomes, engine
job results and esbuild's API were independently described by incomplete local types. These declarations
could continue compiling after the application contract changed. Replace them with the owning types and
validate HTTP responses against the existing schemas. Keep narrowly scoped expected-document views when
they describe only the fields an assertion needs; converting every view to a full application type is not
necessary to improve correctness.

The testkit already provides useful reusable image, fuzz and oracle helpers. Consolidating its public
helpers is preferable to creating another test abstraction. In particular, the E2E Remotion-host test
should use the browser bundler; the bundler should depend explicitly on esbuild rather than reach into
tsx's transitive dependency and assert a made-up build signature.

Several error paths concealed the failure that mattered. A failure to save a fuzz reproducer disappeared
from the report. Source scanning treated every filesystem error as an absent directory, allowing a
broken scan to look successful. Optional text-animation fields were queried as required paths and every
query failure was then treated as absence. Narrow these boundaries without removing the catches that
classify hostile parser inputs, expected missing files, process cleanup, or sandbox security failures.

Fixture generation selected x264 when both encoders were installed even with
`JASPER_FFMPEG_LGPL_ONLY=1`, and selected x264 when neither supported encoder existed. This contradicted
the LGPL-only fixture contract and delayed diagnosis until an encode failed. Encoder selection should
be explicit, independently tested and reject unavailable configurations before generation starts.

`unknown` is appropriate for arbitrary fuzz inputs, thrown values, raw ffprobe JSON and generic agent
query results. Pretending these are validated documents or codec metadata would weaken the boundary.
Most remaining E2E `unknown` values occur at those boundaries or on intentionally opaque fields. Explicit
`any` in the performance HTTP helper was unnecessary: return `Response` and parse each endpoint with its
actual schema. A production-source Biome rule should prevent new explicit `any` types while permitting
malformed-input tests to remain outside that rule's scope.

Comments that narrated test steps, repeated module exports, labelled obvious sections or recorded prior
behavior added little. Remove those comments while retaining format details, timing rationale, sandbox
constraints, attribution and the reason a measurement differs from ordinary UI behavior.

## Implemented

- E2E `window.jasper` declarations use the application's type-only `JasperAgentApi` contract, extracted
  by the web-shell audit. Shared setup accepts `CommandInput[]`; transaction results use the real
  discriminated union, with one assertion helper for successful outcomes. Local result assertions and
  fallback empty reference maps were removed. History origins use `Origin`.
- Job polling and export downloads validate with `EngineJobSchema`, `JobListResponseSchema`,
  `ExportResultSchema` and `StillResultSchema`; terminal states come from the shared set. The export
  helper returns the actual export-result type.
- Text-animator checks use `TextClip` and query the existing clip before reading optional fields. Gap
  tests use `ProjectDocument` and its current `doc.get` response shape, without legacy envelope guesses
  or a catch that concealed document-query errors.
- Performance fixture transactions use `Command[]`, media inputs derive from `CommandOf<'media.register'>`,
  project uploads use `ProjectEnvelope`, and upload responses use their endpoint schemas. Trace extras
  use the scenario-result shape rather than an unchecked record cast.
- The browser bundler imports esbuild directly and accepts an optional IIFE global name. The E2E
  Remotion-host test reuses it. `@jasper/testkit` declares the existing esbuild version range as a development
  dependency.
- Fixture context and recipe types are shared by the generator and fixture declarations. PSD generation
  takes the real `ag-psd.writePsdBuffer` signature; root tooling declares the same `ag-psd` version already
  used by the engine as a development dependency.
- Fixture H.264 selection respects LGPL-only mode, reports missing encoders before writing media, and
  propagates encoder-probe failures. Unexpected lock-release errors are reported instead of discarded.
- Fuzz failures retain both the parser failure and a separate reproducer-write error. Golden blessing
  encodes each image once and writes those checked bytes. Tolerances use `satisfies`; generic JSON record
  writing preserves its value type. Redundant discovery catches and casting through `unknown` were removed.
- Asset and token scans suppress only missing-file errors; other I/O failures remain failures. Token-check
  tests clean up their temporary directories.
- Biome rejects explicit `any` under `apps/**/src/**` and `packages/**/src/**`. Test files remain outside
  this override. The performance helper's sole explicit `any` was removed.

## Verification and limits

Measured targeted run:

```
pnpm vitest run packages/testkit/test scripts/fixture-encoding.test.mjs \
  scripts/check-tokens.test.mjs scripts/check-assets.test.mjs --maxWorkers=1
```

Seven files and 39 tests passed. These include the existing PNG fuzz target, golden comparisons, external
ffmpeg/ffprobe oracle checks, and new regressions for LGPL-only encoder selection, failed source scans,
fuzz reproducer-write errors, and browser bundling with a global name. No golden references were blessed.

`pnpm --filter @jasper/testkit typecheck` passed before the final E2E integration edits. The E2E typecheck
was deliberately terminated at the integrator's request to reduce contention on the shared host; the
integration gate must run it after the web-shell contract and project-command input type land.
Biome checked 91 changed-scope tooling, testkit and E2E files without findings; `git diff --check` is clean.
`pnpm exec playwright test --list` collected 234 tests in 54 files. This checks collection, not live browser
behavior.

The final lockfile is regenerated centrally because other audit workstreams also change workspace
manifests. Full verification, live browser E2E behavior, fixture-media regeneration and macOS/Windows
packaging are integration checks; this audit does not claim those were exercised here. Platform-specific
fallback discovery, dev-only FFmpeg selection, cleanup handlers and hostile-input fuzz boundaries were
retained because they implement explicit behavior rather than dead compatibility branches.
