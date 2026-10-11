# Code quality audit: audio DSP, audio effects and animation

Scope: `packages/audio-dsp`, `packages/audio-fx`, `packages/motion` and
`packages/mg-templates`, including their tests and schema generator. This audit
preserves the audio sample calculations, template schemas, animation timing and
existing project compatibility behavior.

## Assessment and implemented recommendations

| Finding | Assessment | Change |
| --- | --- | --- |
| Two radix-2 complex FFT implementations | Both ports calculate the same unscaled transform in double precision. Keeping separate butterfly, bit-reversal and twiddle implementations creates unnecessary opportunities for preview/export and sync behavior to diverge. The stateful effects API and cached sync API still have different lifetimes. | `audio-dsp` owns `Fft`; its `fft` function retains the bounded small-plan cache. `audio-fx` exports the same class through its existing public path. |
| FFT constructor and buffer contract | The effects constructor accepted `NaN` and fractional lengths through bitwise coercion. A short imaginary buffer could then propagate non-finite values and mutate the real buffer. The transform loop also used a signed bit shift for its stage size. | Validate plan sizes before allocation, reject mismatched buffers before mutation, and multiply stage lengths without signed overflow. Regression tests cover malformed sizes and untouched buffers on refusal. |
| Forwarding wrappers and numeric duplicates | The effects biquad design/magnitude functions simply delegated to `audio-dsp`. Decibel-to-amplitude and recursive-state denormal flushing were identical implementations. | Re-export those functions with the existing effects names. Keep the coefficient-free effects biquad state: filter banks intentionally share one coefficient set across channels. |
| Repeated RGBA schemas | Both native SVG templates and the anime metadata duplicated the same range checks, length and defaults. Replacing the arrays with tuples would change the native JSON schema and therefore is inappropriate for this cleanup. | One `rgbaParam` factory preserves the existing array schema. `Rgba`, `MgRational` and template canvas props reuse project/template types. |
| Weak types despite known data | Template erasure used explicit `any`; animation caches/tweens used `unknown` for numeric values; the render harness asserted arbitrary props, commands, clips and browser globals. Audio hosts asserted parameter values to numbers even though enums and booleans are valid. | Use the existing generic template contract, numeric records/tuples, project commands, discriminated clip narrowing, composition props, a shared browser harness interface and inferred cache/schema output. `ChainEffect` derives its fields from `EffectInstance`. |
| Untyped test tooling | The render test loaded another package's dev dependencies through `createRequire`, then erased the renderer API to `any`. That concealed incorrect calls and duplicated dependency knowledge. | Declare the already-used pinned Remotion renderer/bundler and esbuild as motion dev dependencies; load their typed APIs in the opt-in suite setup. The production dependency graph is unchanged. |
| Exception handling hiding coverage | The determinism harness caught any schema-conversion exception and silently omitted enum variants. This could report a passing test while skipping precisely the cases the harness should cover. | Let schema-conversion failures fail the test. |
| Stale and redundant comments | Several comments restated type names, reset methods, obvious sections or workstream ownership. Render fixtures still described a future shape command and an empty animator catalog. | Remove those comments and the empty-catalog fixture branch. Preserve explanations of units, DSP formulas, render parity, licensing, cache bounds and browser/anime workarounds. |

## Research and retained behavior

The review used `AGENTS.md`, `CLAUDE.md`, architecture §3.1 and decisions D-12,
D-31 and D-42, `docs/wp-notes/audio-fx.md`, the animation/template notes, and the
actual project schema and installed package declarations. In particular:

- `project/src/schema/common.ts`, `schema/sequence.ts` and the command schemas
  own document parameters, effect instances, colors, clip discriminators and
  transaction commands. Their existing exports are used rather than inventing
  narrower parallel interfaces.
- The installed anime.js 4.5.0 declarations define `DOMTarget` as HTML or SVG
  elements and explicitly accept both string and enum composition values. The
  DOM hook and paused-timeline guard now express those actual types.
- The installed Remotion 4.0.499 declarations own render options, selected
  composition results and `HeadlessBrowser`. The existing composition contract
  owns harness props; the test no longer substitutes generic object records.
- `licenses/ported/audio-fx.md` and `licenses/ported/multicam.md` identify both
  FFT ports. The audio-effects record now points to the shared implementation.
  Integration must regenerate notices together with its dependency lockfile.

The following constructs remain for specific reasons:

- `unknown` at schema boundaries is intentional: installed templates and text
  presets accept different shapes, and saved parameters must be validated by
  their selected schema. The `canonicalJson` input is similarly arbitrary
  JSON-like data. Claiming a concrete shape before validation would weaken
  safety. There are no explicit TypeScript `any` annotations in this scope.
- Template upgrade migration callbacks can throw or reject old parameters.
  `upgradeParams` must try another valid migration path without discarding a
  user's original parameters. Its catch is the documented compatibility
  boundary, with existing tests for failing paths and successful alternatives.
- The SVG test's `try/finally` closes its DOM window even if an assertion fails.
- Unknown effect IDs, unresolved presets, clamped/sanitized parameter values,
  silence handling and missing `Intl.Segmenter` support implement existing
  project/runtime contracts. Removing them would change rendering, browser
  support or loading behavior. They are not unused legacy paths.
- Audio-mix and audio-effects processor interfaces deliberately differ: mixer
  hosts operate in document time, while DSP processors work on in-place sample
  ranges. Likewise, the two biquad state shapes serve different ownership and
  smoothing requirements. Merging either pair would add adapters and coupling.

No placeholder processor or unimplemented template was found in the audited
package source. The registry contract tests continue to cover installed effect
coverage, reset, finite outputs and block-size independence.

## Verification

Measured checks:

- Before/after comparison against both original FFT implementations: **28
  bit-identical transforms**, complex inputs, forward and inverse, sizes 2, 4,
  8, 16, 128, 1024 and 8192. No tolerances were used for that comparison.
- New FFT property test compares complex transforms against an independently
  calculated discrete Fourier transform and checks inverse normalization.
  The old effects implementation was separately confirmed to accept both
  `NaN` and `2.5` as plan sizes; the new regression requires refusal.
- Relative import graph scan: **85 source modules, 239 import/re-export edges,
  zero cycles**. The architectural layer checker also passes; sharing flows
  from `audio-fx` to `audio-dsp`, never the reverse.
- `pnpm exec biome check --write packages/audio-dsp packages/audio-fx
  packages/motion packages/mg-templates`: passed across 145 files.
- `node scripts/check-anime.mjs` and `git diff --check`: passed.
- Focused Vitest run is pending at the source commit. The audio-effects
  registry suite reported one failure after its extreme-settings case took
  202 seconds under host contention; the final failure detail and remaining
  suites will be reported separately. No assertions or test-source timeouts
  have been relaxed.

The audio-DSP typecheck passed before the integration coordinator stopped
parallel typechecks to reduce host contention. The final serialized workspace
typecheck and complete verification gate belong to integration. Native SVG
parity and browser render parity are opt-in suites; this source/type cleanup
does not claim a new native-render or browser-frame measurement.
