# Audio DSP, effects, motion and template test cleanup

Status: completed cleanup implementation; validation is pending the integration owner’s scheduled gates. Dispositions were recorded before test/source edits; final checks and limits are recorded below. All 35 assigned files reviewed, including helper implementations and production callers. Parameterized declarations cover every generated case.

Each retained entry below explicitly records B1 source/contract, B2 failure, B3 independent expectation, B4 stable observation, B5 refactor resilience and B6 ownership. Mathematical identities are retained only when they describe the promised transform/output; private representation checks and tests of test-only wrappers are removed.

Risk/checks common to every row: no production processing changes are authorized by pruning. Validate with `pnpm exec vitest run <path> --maxWorkers=1` (deleted files: their named surviving owner), and `pnpm --filter @jasper/<package> typecheck`. Optional native/render tests additionally require `MG_PARITY=1` / `REMOTION_E2E=1`; loudness oracle validation requires a working FFmpeg and `JASPER_REQUIRE_ORACLES=1`. Repository gates are run by integration owner.

## packages/audio-dsp/test/biquad.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `biquad.ts, kweight.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — peaking hits gain at centre

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: peaking hits gain at centre.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — low-pass / high-pass are −3 dB at the cut-off

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: low-pass / high-pass are −3 dB at the cut-off.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — notch is deep at centre

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: notch is deep at centre.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — shelves reach their gain

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: shelves reach their gain.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — band-pass and all-pass

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: band-pass and all-pass.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — constant-bandwidth cut reaches its depth

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: constant-bandwidth cut reaches its depth.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — state flushes to zero (no denormals)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: state flushes to zero (no denormals).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — reset clears the memory and setCoeffs keeps it

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: reset clears the memory and setCoeffs keeps it.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — matches the BS.1770-4 coefficient table at 48 kHz (1e-6)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: matches the BS.1770-4 coefficient table at 48 kHz (1e-6).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — shape is sample-rate independent

Only tests analytical tooling that has no production consumer; independent FFmpeg oracle across sample rates owns audible K-weighting response. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-dsp/test/channels.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `channels.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — layout basics

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: layout basics.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — BS.775 downmix coefficients are exact

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: BS.775 downmix coefficients are exact.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — upmix places the source on the front speakers; identity matrices

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: upmix places the source on the front speakers; identity matrices.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — convert applies the matrix per sample

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: convert applies the matrix per sample.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — applyMatrix: offset/length, gain, accumulate and in-place

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: applyMatrix: offset/length, gain, accumulate and in-place.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — mono pan is constant power with −3 dB centre

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: mono pan is constant power with −3 dB centre.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — stereo balance: unity centre, far side cosine

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: stereo balance: unity centre, far side cosine.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — point gains are equal power

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: point gains are equal power.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — panner matrices

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: panner matrices.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/ducking.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `ducking.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — envelope levels

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: envelope levels.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — activity bridges gaps, then drops blips

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: activity bridges gaps, then drops blips.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — sensitivity mapping

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: sensitivity mapping.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — duck keyframes: basic and merged

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: duck keyframes: basic and merged.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — duck keyframes are clamped to the clip

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: duck keyframes are clamped to the clip.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — planDucking: trigger activity → keyframes in sequence time

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: planDucking: trigger activity → keyframes in sequence time.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/fft.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `fft.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — agrees with the discrete Fourier transform for complex input

- B1: DFT definition/inverse normalization; docs/wp-notes/code-audit-audio-animation.md FFT bounds/mismatch regression; AGENTS allocation safety. Contract exercised: agrees with the discrete Fourier transform for complex input.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — rejects invalid plan size %s before allocating

- B1: DFT definition/inverse normalization; docs/wp-notes/code-audit-audio-animation.md FFT bounds/mismatch regression; AGENTS allocation safety. Contract exercised: rejects invalid plan size %s before allocating.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — rejects mismatched buffers before changing either buffer

- B1: DFT definition/inverse normalization; docs/wp-notes/code-audit-audio-animation.md FFT bounds/mismatch regression; AGENTS allocation safety. Contract exercised: rejects mismatched buffers before changing either buffer.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/limiter.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `limiter.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — keeps the output true peak ≤ ceiling + 0.05 dB on adversarial inputs (1.5 ms and 5 ms look-ahead)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: keeps the output true peak ≤ ceiling + 0.05 dB on adversarial inputs (1.5 ms and 5 ms look-ahead).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — limits steady loud material to the ceiling (not far below)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: limits steady loud material to the ceiling (not far below).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — is transparent below the ceiling, with the reported latency

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: is transparent below the ceiling, with the reported latency.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove latency formula copied from private support/guard constants; keep actual output and flush alignment against reported public latency.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — limitBuffer is time aligned, same length, input untouched

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: limitBuffer is time aligned, same length, input untouched.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — attack is smooth (no gain step) and release recovers

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: attack is smooth (no gain step) and release recovers.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — block-size independent and reset restores the initial state

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: block-size independent and reset restores the initial state.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — property: random signals never exceed the ceiling + 0.05 dB

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: property: random signals never exceed the ceiling + 0.05 dB.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/loudness-oracle-signals.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `loudness.ts, oversample.ts, kweight.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### REWRITE — sines from 20 Hz to 15 kHz at various levels; different L/R; mono; 32 / 44.1 / 48 / 96 kHz

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: sines from 20 Hz to 15 kHz at various levels; different L/R; mono; 32 / 44.1 / 48 / 96 kHz.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove sine loudness expectation computed using production K-weighting. Independent FFmpeg comparison and analytic true peak remain.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — 5.1 (L R C LFE Ls Rs, mask 0x3F): LFE excluded, surrounds +1.5 dB, layout agreed with ffmpeg

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: 5.1 (L R C LFE Ls Rs, mask 0x3F): LFE excluded, surrounds +1.5 dB, layout agreed with ffmpeg.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove production-derived sine loudness expectation; independent FFmpeg layout and loudness comparison remains.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — seeded white and pink noise; speech-like programmes

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: seeded white and pink noise; speech-like programmes.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — gated programmes: digital silence and quiet passages exercise both gates

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: gated programmes: digital silence and quiet passages exercise both gates.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — loudness-modulated programmes (LRA)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: loudness-modulated programmes (LRA).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — true peak: inter-sample-peak sines (fs/4 at 45°) and off-grid tones

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: true peak: inter-sample-peak sines (fs/4 at 45°) and off-grid tones.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/loudness-oracle.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `loudness.ts, oversample.ts, kweight.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — Tech 3341 cases 1, 2: stereo 1 kHz sine at −23 / −33 dBFS → M, S, I = −23.0 / −33.0 LUFS

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: Tech 3341 cases 1, 2: stereo 1 kHz sine at −23 / −33 dBFS → M, S, I = −23.0 / −33.0 LUFS.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Tech 3341 cases 3, 4, 5: gated sequences → −23.0 LUFS

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: Tech 3341 cases 3, 4, 5: gated sequences → −23.0 LUFS.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Tech 3341 case 9 style: S stays −23.0 with 1.34 s @ −20 / 1.66 s @ −30 dBFS alternation

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: Tech 3341 case 9 style: S stays −23.0 with 1.34 s @ −20 / 1.66 s @ −30 dBFS alternation.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Tech 3341 cases 10, 12 style: max S of 3 s bursts and max M of 0.4 s bursts at −23 dBFS

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: Tech 3341 cases 10, 12 style: max S of 3 s bursts and max M of 0.4 s bursts at −23 dBFS.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Tech 3342 LRA cases 1–4 (1 kHz stereo)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: Tech 3342 LRA cases 1–4 (1 kHz stereo).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/loudness.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `loudness.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### DELETE — Tech 3341 cases 1 & 2: stereo sine at −23 / −33 dBFS

Published cases already checked against both FFmpeg and published EBU results in loudness-oracle.test.ts; this extra replay adds no contract. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — Tech 3341 cases 3 & 4: absolute and relative gating

Duplicate absolute/relative gating cases owned by loudness-oracle.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — Tech 3341 case 5: relative gate

Duplicate relative gating case owned by loudness-oracle.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — silence and below-gate programmes

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: silence and below-gate programmes.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — Tech 3342 loudness range

Duplicate Tech 3342 cases owned by loudness-oracle.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — log sweep matches the analytic K-weighting

Expected sweep response uses production kWeightingPower and energyToLufs; cannot independently detect their shared errors. FFmpeg synthetic-frequency/noise cases remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — surround weights: Ls +1.5 dB, LFE excluded

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: surround weights: Ls +1.5 dB, LFE excluded.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Keep only custom-weight override output; ordinary surround/LFE behavior belongs to FFmpeg oracle.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — default channel weights

Default-weight declarations duplicate actual channel-weighted output in loudness-oracle-signals.test.ts; engine callers remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — true peak of inter-sample-peak signals

Same intersample-peak LoudnessMeter contract is checked against FFmpeg and analytic amplitude in loudness-oracle-signals.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — reset clears everything

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: reset clears everything.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — normalisation helpers

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: normalisation helpers.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove test-only energy conversion round-trip; keep independently expected target/cap/silence normalization and measured target result.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — tiny blocks equal big blocks; mono has no dual-mono +3 dB

Block independence is owned by the broader randomized-block property; mono gain by the FFmpeg mono case. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — missing channels count as silence; measureLoudness summarises

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: missing channels count as silence; measureLoudness summarises.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — property: results do not depend on how the input is cut into blocks

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: property: results do not depend on how the input is cut into blocks.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/meter.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `meter.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — linToDb / dbToLin / faderDbToGain

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: linToDb / dbToLin / faderDbToGain.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — reports peak, windowed RMS and clipping per channel since the last take

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: reports peak, windowed RMS and clipping per channel since the last take.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — RMS is the max of the running window, block-size independent, and drift-free

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: RMS is the max of the running window, block-size independent, and drift-free.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — missing channels read silence; reset clears

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: missing channels read silence; reset clears.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — instant attack, linear dB release, peak hold then fall

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: instant attack, linear dB release, peak hold then fall.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/oversample.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `oversample.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### DELETE — phases have unity DC, mirror each other and interpolate sines

Private coefficient layout, mirror/fold implementation and direct convolution of production coefficients; detector sine output and FFmpeg oracle are stronger. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — oversampling factor reaches ≥ 176.4 kHz

Exact interpolation factors constrain an implementation choice, whereas BS.1770 requires output accuracy. Detector and FFmpeg multi-rate cases remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — measures inter-sample peaks: fs/4 sine at 45° (44.1/48 kHz), 12 kHz off-grid at 96 kHz (2×)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: measures inter-sample peaks: fs/4 sine at 45° (44.1/48 kHz), 12 kHz off-grid at 96 kHz (2×).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — is at least the sample peak, per channel, and block-size independent

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: is at least the sample peak, per channel, and block-size independent.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove equality probe of dead blockTruePeak wrapper; keep channel maxima, reset and streaming independence.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/resample.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `resample.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — length = round(len · to / from); equal rates copy

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: length = round(len · to / from); equal rates copy.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — high: sine amplitude (< 0.01 dB), frequency and phase preserved up to 0.45·min(fs)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: high: sine amplitude (< 0.01 dB), frequency and phase preserved up to 0.45·min(fs).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — high: rejects aliasing ≥ 90 dB when downsampling

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: high: rejects aliasing ≥ 90 dB when downsampling.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — high: rejects imaging ≥ 90 dB when upsampling

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: high: rejects imaging ≥ 90 dB when upsampling.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — fast: passband to 0.4·min within 0.01 dB, stop band ≥ 65 dB

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: fast: passband to 0.4·min within 0.01 dB, stop band ≥ 65 dB.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — time alignment of an impulse and arbitrary (dense-table) ratios

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: time alignment of an impulse and arbitrary (dense-table) ratios.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/smooth.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `smooth.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — ramps linearly and lands exactly

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: ramps linearly and lands exactly.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — retarget mid-ramp is continuous

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: retarget mid-ramp is continuous.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — zero ramp is immediate

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: zero ramp is immediate.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — withMs, snap and setImmediate

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: withMs, snap and setImmediate.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/sync.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `sync.ts`. Non-test callers: apps/engine/src/sync/service.ts and packages/audio-fx/src/analysis/remix.ts.

### DELETE — matches a naive DFT and round-trips

Duplicate of fft.test.ts randomized complex DFT mathematical oracle and inverse normalization; sync should own audio alignment. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — keeps low frequencies and removes high ones

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: keeps low frequencies and removes high ones.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — mixdown averages channels

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: mixdown averages channels.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — finds pure delays exactly, both signs, and marks them reliable

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: finds pure delays exactly, both signs, and marks them reliable.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — three microphones with different gains, noise (25, 10, 3 dB SNR), colouring and fractional delays: within one sample

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: three microphones with different gains, noise (25, 10, 3 dB SNR), colouring and fractional delays: within one sample.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — room echo 23 ms later at 0 dB SNR: the direct path wins

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: room echo 23 ms later at 0 dB SNR: the direct path wins.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — finds inverted polarity

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: finds inverted polarity.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — partial overlap: b covers only the last 4 s of a, and starts before a

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: partial overlap: b covers only the last 4 s of a, and starts before a.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — sub-sample delays come out of the parabolic refinement

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: sub-sample delays come out of the parabolic refinement.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — unrelated, silent or too-short signals are not trusted

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: unrelated, silent or too-short signals are not trusted.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — maxLag limits the search

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: maxLag limits the search.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — works at other sample rates (44.1 kHz decimates by 6 to 7.35 kHz)

- B1: docs/wp-notes/multicam.md GCC-PHAT lag/polarity/reliability contract; public findOffset/decimate/mixdown API. Contract exercised: works at other sample rates (44.1 kHz decimates by 6 to 7.35 kHz).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-dsp/test/wav.test.ts

Production owner(s), relative to `packages/audio-dsp/src/` unless absolute repo path shown: `wav.ts`. Non-test callers: packages/project/src/audio/mixer.ts; packages/compositions/src/audio/*; apps/engine/src/audio/{service,mixdown,decode}.ts.

### KEEP — f32 round trip is bit exact, mono/stereo use plain IEEE float with fact chunk

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: f32 round trip is bit exact, mono/stereo use plain IEEE float with fact chunk.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — 6 channels use WAVE_FORMAT_EXTENSIBLE with the 5.1 mask

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: 6 channels use WAVE_FORMAT_EXTENSIBLE with the 5.1 mask.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — integer formats round and clip

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: integer formats round and clip.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — decodes 8/16/24/32-bit PCM, 32/64-bit float, with unknown chunks and pad bytes

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: decodes 8/16/24/32-bit PCM, 32/64-bit float, with unknown chunks and pad bytes.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — streamed data size and errors

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: streamed data size and errors.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — property: encode/decode round trip (f32 exact, integer within half an LSB)

- B1: docs/wp-notes/audio-mix.md §§1,3; ARCHITECTURE D-42; the documented public DSP API and cited BS.1770/BS.775/RBJ/WAVE standards. Contract exercised: property: encode/decode round trip (f32 exact, integer within half an LSB).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed physical-unit values, hand-built WAVE bytes, analytic signal amplitude/frequency, independent DFT, or equal-input streaming invariants. They can disagree with production.
- B4: public DSP functions/classes (index.ts and the sync.ts/fft.ts modules consumed by engine and effects); numeric samples/levels/results, not private calls.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-fx/test/core.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `core/util.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### DELETE — peaking hits its gain at the centre and matches the cookbook everywhere

Re-exported coefficient design/magnitude already owned by audio-dsp/biquad.test.ts; filter-eq.test.ts checks actual effect output. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — low-pass / high-pass are −3.01 dB at the cutoff with 12 dB/oct slopes

Duplicate audio-dsp biquad numeric owner and public filter-eq output contracts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — notch is deep at the centre, shelves reach their gain, band-pass/all-pass are unity

Duplicate audio-dsp biquad numeric owner and public filter-eq output contracts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — state flushes to exact zero

Public processor extreme/tail suite owns the f32 denormal contract; direct low-level state replay adds no output contract. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — delay line reads integer and fractional delays

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: delay line reads integer and fractional delays.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — first-order all-pass has unit magnitude

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: first-order all-pass has unit magnitude.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — PRNG is deterministic and uniform

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: PRNG is deterministic and uniform.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-fx/test/delay-modulation.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/delay-modulation.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### KEEP — Delay: echoes at exactly the delay with the feedback series g, g², … and the mix law

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Delay: echoes at exactly the delay with the feedback series g, g², … and the mix law.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — tempo sync: note values at a tempo

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: tempo sync: note values at a tempo.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove private tempoDelayMs assertions; exercise the tempo/division settings through actual delay impulse outputs, preserving the independently calculated beat durations.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Multitap: taps at their times and levels

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Multitap: taps at their times and levels.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Analog Delay stays bounded with 200 % feedback and trash

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Analog Delay stays bounded with 200 % feedback and trash.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — Phaser notches sweep between the upper frequency and 6·depth octaves below

Asserts private sweepHz arithmetic; can pass with completely broken Phaser processing. Public dry identity and registry streaming/extremes remain; no independent numeric phaser sweep requirement beyond implementation. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — Flanger: a static delay makes comb notches at odd multiples of 1/(2·delay)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Flanger: a static delay makes comb notches at odd multiples of 1/(2·delay).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — LFO rate: the chorus/flanger sweep repeats at Speed (±2 %)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: LFO rate: the chorus/flanger sweep repeats at Speed (±2 %).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — mix 0 is identity for the modulation effects; determinism

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: mix 0 is identity for the modulation effects; determinism.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove second-instance determinism replay already owned by registry streaming suite; retain actual zero-mix samples.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-fx/test/design.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/filter-eq/scientific.ts, core/design.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### DELETE — Butterworth matches the closed form (pre-warped), −3.01 dB at the cutoff

Test-only design wrapper duplicates scientific-filter and parametric Butterworth public response contracts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — Butterworth stop band falls 6·N dB per octave

Duplicate Scientific Filter public cutoff/slope contract in filter-eq.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — Bessel is −3 dB at the cutoff and monotonic

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Bessel is −3 dB at the cutoff and monotonic.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: public AudioProcessor.responseDb via real scientific-filter instance after rewrite.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Exercise the real scientific-filter responseDb API; delete the test-only design wrapper. Bessel corner and monotonic behavior are not otherwise covered.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — Chebyshev I ripple stays within the bound and reaches it

Duplicate public Scientific Filter ripple contract in filter-eq.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — Chebyshev I pass-band ripple equals the parameter

Duplicate public Scientific Filter parameter/ripple contract. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — elliptic meets its pass-band ripple and stop-band attenuation

Duplicate public Scientific Filter attenuation/ripple contract. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — high-pass, band-pass and band-stop shapes for every family

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: high-pass, band-pass and band-stop shapes for every family.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: public AudioProcessor.responseDb via real scientific-filter instance after rewrite.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Exercise the real scientific-filter responseDb API across every family/mode; remove private section representation and test-only wrapper.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — complex helpers and Jacobi elliptic functions

Complex/Jacobi helper identities keep test-only exports and unused ellipK alive; public elliptic responses guard audible design. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — every design is stable (all poles inside the unit circle)

Asserts private SOS poles/section layout. Public processor extreme-settings/tail test guards unstable output without requiring a specific realization. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/dynamics.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/dynamics/{single,rack,limiter,curves}.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### DELETE — equals the textbook soft-knee formula and is continuous and monotonic

Direct private compressorCurve formula repeats the same piecewise implementation. Public steady-state processor/transferDb case already uses independently published GMR curve. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — steady-state sine output matches transferDb within 0.2 dB (peak and RMS detectors, several settings)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: steady-state sine output matches transferDb within 0.2 dB (peak and RMS detectors, several settings).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Compare both audio output and public transferDb to the published GMR formula directly, rather than deriving expected audio from transferDb.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — attack and release time constants (63 % of the change in dB) are within 15 % of the params

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: attack and release time constants (63 % of the change in dB) are within 15 % of the params.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

- Rewrite: Use independently calculated −19 dB steady gain reduction (threshold −20 dB, ratio 20:1, input 0 dB), removing the production compressorCurve oracle.

### KEEP — never exceeds Maximum Amplitude (sample peak), at any boost, in random blocks

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: never exceeds Maximum Amplitude (sample peak), at any boost, in random blocks.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — with True Peak the 4× interpolated true peak stays within ceiling + 0.1 dB

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: with True Peak the 4× interpolated true peak stays within ceiling + 0.1 dB.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — is a pure delay below the ceiling; latency equals the measured impulse delay

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: is a pure delay below the ceiling; latency equals the measured impulse delay.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — brings a loud sine to the ceiling smoothly

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: brings a loud sine to the ceiling smoothly.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Expander / Gate attenuates by the range below the threshold and holds

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Expander / Gate attenuates by the range below the threshold and holds.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — Dynamics rack: compressor section follows its curve; auto makeup; gate closes; soft clip bounded

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Dynamics rack: compressor section follows its curve; auto makeup; gate closes; soft clip bounded.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

- Rewrite: Remove private softClip probes; retain public rack transfer curve, actual gate attenuation/meter and processed limiter ceiling.

### KEEP — Multiband crossovers sum flat (±0.1 dB) when no band compresses

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Multiband crossovers sum flat (±0.1 dB) when no band compresses.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Multiband compresses only the band over its threshold and meters it

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Multiband compresses only the band over its threshold and meters it.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Tube-modeled compressor is near-transparent at low level and compresses loud signals

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Tube-modeled compressor is near-transparent at low level and compresses loud signals.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — is deterministic

Duplicate determinism contract already checked with parameter changes and varied partitions in registry.test.ts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/filter-eq.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/filter-eq/{eq,scientific,fft-filter}.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### KEEP — Highpass / Lowpass / Bandpass

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Highpass / Lowpass / Bandpass.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Bass / Treble shelves at 200 Hz and 4 kHz

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Bass / Treble shelves at 200 Hz and 4 kHz.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Low Shelf / High Shelf

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Low Shelf / High Shelf.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Simple Parametric EQ and Simple Notch Filter

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Simple Parametric EQ and Simple Notch Filter.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — notches are at least 40 dB deep at their centre

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: notches are at least 40 dB deep at their centre.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — parameter changes glide (Simple Parametric EQ) and reach the target

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: parameter changes glide (Simple Parametric EQ) and reach the target.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — default parametric is flat

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: default parametric is flat.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — parametric bands match the analytic response

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: parametric bands match the analytic response.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — band types cover peaking, shelves, pass, notch and band-pass (cookbook)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: band types cover peaking, shelves, pass, notch and band-pass (cookbook).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove catalogue options inventory; retain all measured band-type responses against independent RBJ formulas.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — simple 3-band EQ gains

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: simple 3-band EQ gains.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — gain change glides without a jump

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: gain change glides without a jump.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — band centres are the ISO 266 octave, half-octave and third-octave frequencies

Private frequency/Q table and label declaration assertions; adjacent public response test independently visits every ISO centre. Wording and internal Q formula are not product contracts. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — a single band at +12 dB peaks at its centre (every band of every size)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: a single band at +12 dB peaks at its centre (every band of every size).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove production-Q-derived equality; independently fixed ISO centres, 12 dB maximum and neighboring response remain.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — bands hit their gain, measured (premiere_tests)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: bands hit their gain, measured (premiere_tests).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Use independent octave-bandwidth Q law in the test oracle rather than importing production graphicEqQ.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — 24 dB/oct high-pass: −3 dB at the corner, ≈ −48 dB two octaves down (premiere_tests)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: 24 dB/oct high-pass: −3 dB at the corner, ≈ −48 dB two octaves down (premiere_tests).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — pass filters of every slope are digital Butterworths (6·N dB/oct)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: pass filters of every slope are digital Butterworths (6·N dB/oct).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — shelves and peaking bands follow the cookbook; bands switch off

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: shelves and peaking bands follow the cookbook; bands switch off.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — removes tones and leaves the neighbours

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: removes tones and leaves the neighbours.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — is a neutral pass-through by default and matches its analytic response

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: is a neutral pass-through by default and matches its analytic response.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — matches its design, measured (premiere_tests)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: matches its design, measured (premiere_tests).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Butterworth: −3.01 dB at the cutoff and a 6·N dB/oct asymptote

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Butterworth: −3.01 dB at the cutoff and a 6·N dB/oct asymptote.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Chebyshev pass-band ripple equals the parameter; elliptic stop band ≥ the attenuation

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Chebyshev pass-band ripple equals the parameter; elliptic stop band ≥ the attenuation.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — master gain and cutoff glides reach the target design

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: master gain and cutoff glides reach the target design.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — applies its curve (premiere_tests)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: applies its curve (premiere_tests).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — magnitude follows a smooth curve at many frequencies

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: magnitude follows a smooth curve at many frequencies.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — latency() equals the measured impulse delay

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: latency() equals the measured impulse delay.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove hard-coded FFT buffer-size latency; keep measured impulse/dry alignment with reported latency.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — every effect reports a finite analytic response and the right editor

Catalogue size/category/editor inventory and finite-only probe; actual response tests cover output and UI controls have their own owner. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — runs well faster than realtime (stereo 48 kHz)

Unspecified 1.5-second local timing threshold; no independent performance requirement for this speed multiplier. Actual response and streaming contracts remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/registry.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `registry.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### REWRITE — every catalogue entry has exactly one processor with matching params

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: every catalogue entry has exactly one processor with matching params.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Drop catalogue/default/key-shape inventories and numericDefault self-oracle; retain public refusal of unknown processor/parameter ids.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — output is independent of the block size, with a parameter change mid-stream

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: output is independent of the block size, with a parameter change mid-stream.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — handles empty, single-sample, mono and extra-channel blocks

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: handles empty, single-sample, mono and extra-channel blocks.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Keep empty/mono/sample safety at public process seam; assert every output stays finite and extra channels pass through, rather than checking only a stale earlier buffer.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — extreme settings stay finite and tails end without subnormals

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: extreme settings stay finite and tails end without subnormals.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — reset restores the initial behaviour

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: reset restores the initial behaviour.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-fx/test/remix.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `analysis/remix.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### KEEP — finds tempo within 1 BPM and beats within 10 ms

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: finds tempo within 1 BPM and beats within 10 ms.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — similarity prefers the same section

Tests private similarity scoring on its own analysis object, not any selected edit; public beat-boundary/intro/outro/target plan cases remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — silence, a steady tone and noise have no beat

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: silence, a steady tone and noise have no beat.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — hits targets within a beat (half a beat at default settings), at beat boundaries, keeping intro and outro

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: hits targets within a beat (half a beat at default settings), at beat boundaries, keeping intro and outro.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — is deterministic; Segments changes the number of joints; identity at the source length; too-short targets refused

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: is deterministic; Segments changes the number of joints; identity at the source length; too-short targets refused.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — analyses a 3-minute song quickly

Unspecified six-second benchmark threshold and a duplicate BPM example; tempo accuracy has its dedicated synthetic-beat owner. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/restoration.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/restoration/{dehum,declick,speech,spectral}.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### KEEP — \`notches ${f0} Hz and every enabled harmonic by ≥ 30 dB, keeps a 1 kHz tone within 0.5 dB\`

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: notches ${f0} Hz and every enabled harmonic by ≥ 30 dB, keeps a 1 kHz tone within 0.5 dB.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — 60 Hz mode leaves 50 Hz mostly alone; Output Hum Only outputs the removed hum

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: 60 Hz mode leaves 50 Hz mostly alone; Output Hum Only outputs the removed hum.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — zero reduction is a pure delay of exactly latency() samples

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: zero reduction is a pure delay of exactly latency() samples.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — \`reduces stationary noise and keeps a tone within 1 dB (${model})\`

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: reduces stationary noise and keeps a tone within 1 dB (${model}).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — learned print gates from the first frame after learning (no adaptation delay)

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: learned print gates from the first frame after learning (no adaptation delay).
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — cuts a sibilant band by ≥ 6 dB and leaves a 300 Hz tone within 0.5 dB

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: cuts a sibilant band by ≥ 6 dB and leaves a 300 Hz tone within 0.5 dB.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — DeReverb at 0 % is a delay; at 100 % it shortens a decaying tail

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: DeReverb at 0 % is a delay; at 100 % it shortens a decaying tail.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Automatic Click Remover removes impulses (≥ 20 dB) and leaves clean audio alone

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Automatic Click Remover removes impulses (≥ 20 dB) and leaves clean audio alone.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Enhance Speech: mix 0 is identity, the EQ shapes a voice band, and noise between words is pushed down

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Enhance Speech: mix 0 is identity, the EQ shapes a voice band, and noise between words is pushed down.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — is deterministic and reports constant latency

Duplicate all-processor streaming/determinism contract; measured latency transparency cases remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### DELETE — spectral effects run faster than 8× realtime (stereo, 10 s)

Unspecified 8x-realtime multiplier; output restoration/latency and stability remain protected. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/reverb-pitch.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/reverb/{convolution,fdn,surround}.ts, effects/pitch.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### DELETE — generated impulses have the specified RT60 (±15 %) and are deterministic

Expected decay is read from private IR_SPECS, and tests generator internals; actual convolution output decay and registry determinism are stronger. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### REWRITE — the processed output of an impulse decays with the impulse RT60; latency = 256

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: the processed output of an impulse decays with the impulse RT60; latency = 256.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Use reported latency for leading silence and RT60 measurement instead of pinning the FFT partition size.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — mix law: 0 % is the delayed dry signal

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: mix law: 0 % is the delayed dry signal.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Compare samples at the public reported latency, allowing equivalent partition-size refactors.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Studio Reverb decays ~60 dB per RT60 and stays bounded

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Studio Reverb decays ~60 dB per RT60 and stays bounded.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — Studio Reverb is stable at the longest decay

Same extreme long-decay stability already covered by registry max-settings finite/tail suite. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — Surround Reverb: dry 100 / wet 0 is identity; the wet tail exists

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Surround Reverb: dry 100 / wet 0 is identity; the wet tail exists.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — \`shifts 440 Hz by ${st} st ${cents} cents within 0.5 %\`

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: shifts 440 Hz by ${st} st ${cents} cents within 0.5 %.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — zero shift is the input delayed by exactly latency() samples

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: zero shift is the input delayed by exactly latency() samples.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### DELETE — runs faster than 8× realtime (stereo, 10 s)

Unspecified 8x-realtime multiplier; pitch-frequency and dry-alignment contracts remain. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

## packages/audio-fx/test/special.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/special/{shaping,mastering}.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### KEEP — Distortion: hard clip makes odd harmonics only; asymmetry adds even ones; output is DC-free and bounded

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Distortion: hard clip makes odd harmonics only; asymmetry adds even ones; output is DC-free and bounded.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — GuitarSuite with everything off is transparent at low level; defaults produce sound

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: GuitarSuite with everything off is transparent at low level; defaults produce sound.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Mastering: transparent at its defaults; EQ follows responseDb; the maximizer raises level under −0.3 dBFS

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Mastering: transparent at its defaults; EQ follows responseDb; the maximizer raises level under −0.3 dBFS.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Vocal Enhancer voicings

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Vocal Enhancer voicings.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Loudness Meter passes audio unchanged and measures exactly like the audio-dsp meter

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Loudness Meter passes audio unchanged and measures exactly like the audio-dsp meter.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Mute ramps to silence over 5 ms without a step

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Mute ramps to silence over 5 ms without a step.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Loudness Auto Gain brings steady signals to the target within 0.5 LU, within the boost/cut limits

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Loudness Auto Gain brings steady signals to the target within 0.5 LU, within the boost/cut limits.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/audio-fx/test/stereo-channel.test.ts

Production owner(s), relative to `packages/audio-fx/src/` unless absolute repo path shown: `effects/stereo-channel.ts`. Non-test callers: packages/audio-fx/src/{host,chain/effect-chain}.ts; packages/compositions/src/audio/fx-processor.ts; apps/web/src/audio-fx/editors.tsx.

### DELETE — constant-power pan sums power to 1; balance is cosine

Duplicate audio-dsp/channels.test.ts constant-power and balance numeric owner. Missing bar: independent ownership and/or stable refactor-safe seam (B3–B6). Risk: removes implementation sensitivity; named surviving public/output owner retains the real contract.

### KEEP — Amplify reaches exact gains, smoothed, linked or not; −96 dB is silence

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Amplify reaches exact gains, smoothed, linked or not; −96 dB is silence.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Channel Volume per channel

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Channel Volume per channel.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — Balance and Pan modes

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Balance and Pan modes.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Replace expected processed balance imported from production balanceGains with independent pan-law values.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Invert, Swap and Fill route exactly

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Invert, Swap and Fill route exactly.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Channel Mixer matrix and Stereo Expander mid/side

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Channel Mixer matrix and Stereo Expander mid/side.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Stereo Width: 0 % is mono, 100 % identity, 200 % doubles the side; mono input stays mono

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Stereo Width: 0 % is mono, 100 % identity, 200 % doubles the side; mono input stays mono.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — full mode: L = R = (L + R)/2 at 100 %, identity at 0 %

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: full mode: L = R = (L + R)/2 at 100 %, identity at 0 %.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — below mode: the crossover sums flat; lows become mono, highs keep their stereo

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: below mode: the crossover sums flat; lows become mono, highs keep their stereo.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove unrelated identity biquad probe; retain measured low/high stereo and crossover output.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — Binauralizer: unity on correlated lows, interaural delay and head shadow

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Binauralizer: unity on correlated lows, interaural delay and head shadow.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — Ambisonics panner: identity at rest, 180° pan puts the left source on the right

- B1: docs/wp-notes/audio-fx.md §§1,5; ARCHITECTURE D-42; published RBJ/GMR/filter/pitch laws and the public AudioProcessor contract. Contract exercised: Ambisonics panner: identity at rest, 180° pan puts the left source on the right.
- B2: A caller receives incorrect audio samples, analysis, protocol bytes or parameter results for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed parameter-selected output values or independently specified acoustic laws; partition/reset equality checks stream semantics. Response-vs-audio assertions check the documented editor-curve promise against actual processed samples, not against a private collaborator. They can disagree with production.
- B4: createProcessor/AudioProcessor samples, responseDb, transferDb, meters, latency and reset; core public primitives only for distinct numeric contracts.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Remove private sourceGains arithmetic assertion; retain rendered stereo direction and bounded output.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/mg-templates/test/anime-contracts.test.ts

Production owner(s), relative to `packages/mg-templates/src/` unless absolute repo path shown: `registry.ts, core.ts, types.ts`. Non-test callers: apps/engine/src/mg/* and routes/mg.ts; packages/project template consumers; packages/compositions/src/layers/MgLayer.tsx; apps/web template gallery/property consumers.

### KEEP — exposes anime routing and gallery metadata without marking fframes entries

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: exposes anime routing and gallery metadata without marking fframes entries.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/mg-templates/test/anime-templates.test.ts

Production owner(s), relative to `packages/mg-templates/src/` unless absolute repo path shown: `templates/anime/{timing,counter,common}.ts, registry.ts`. Non-test callers: apps/engine/src/mg/* and routes/mg.ts; packages/project template consumers; packages/compositions/src/layers/MgLayer.tsx; apps/web template gallery/property consumers.

### KEEP — rejects unknown fields, invalid RGBA channels and oversized text

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: rejects unknown fields, invalid RGBA channels and oversized text.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — exposes actual number and colour controls as keyframable

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: exposes actual number and colour controls as keyframable.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — anchors the intro at content 0 and the outro at the content end; the hold stretches

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: anchors the intro at content 0 and the outro at the content end; the hold stretches.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — sourceIn shifts content time; the outro stays anchored at sourceIn + duration

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: sourceIn shifts content time; the outro stays anchored at sourceIn + duration.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — converts reference frames to whole frames at other rates (frame-exact)

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: converts reference frames to whole frames at other rates (frame-exact).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — compresses intro and outro proportionally when they exceed the content

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: compresses intro and outro proportionally when they exceed the content.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — groups thousands, rounds to the decimals, adds prefix and suffix

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: groups thousands, rounds to the decimals, adds prefix and suffix.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — uses a minus sign for negatives and rounds half away from zero without negative zero

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: uses a minus sign for negatives and rounds half away from zero without negative zero.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — walks the steps to the newest version, validating and defaulting each result

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: walks the steps to the newest version, validating and defaulting each result.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — stops at the requested version and refuses unreachable targets

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: stops at the requested version and refuses unreachable targets.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — prefers a valid direct jump and refuses invalid migration results

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: prefers a valid direct jump and refuses invalid migration results.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — backtracks from a larger dead-end jump to the highest reachable version

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: backtracks from a larger dead-end jump to the highest reachable version.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — tries another path when a direct migration throws

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: tries another path when a direct migration throws.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/mg-templates/test/parity.test.ts

Production owner(s), relative to `packages/mg-templates/src/` unless absolute repo path shown: `templates/{lower-third,title-card}.ts, catalog.ts; native/mg/src/templates/`. Non-test callers: apps/engine/src/mg/* and routes/mg.ts; packages/project template consumers; packages/compositions/src/layers/MgLayer.tsx; apps/web template gallery/property consumers.

### KEEP — schemas/ matches the TS catalog (run \`pnpm --filter @jasper/mg-templates schemas\`)

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: schemas/ matches the TS catalog (run `pnpm --filter @jasper/mg-templates schemas`).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — fframes schemas reject unknown fields and invalid colour or frame values

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: fframes schemas reject unknown fields and invalid colour or frame values.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — \`jasper-mg schema\` equals the TS catalog

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: jasper-mg schema` equals the TS catalog.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### REWRITE — \`jasper-mg svg\` equals the TS twins

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: jasper-mg svg` equals the TS twins.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Replace SVG token/string equality with raster PNG equality for native-generated and TS-generated SVGs in one browser. Preserve explicit preview/export parity requirement while allowing equivalent markup refactors; emit PNG artifacts.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/mg-templates/test/registry.test.ts

Production owner(s), relative to `packages/mg-templates/src/` unless absolute repo path shown: `registry.ts, core.ts, params.ts`. Non-test callers: apps/engine/src/mg/* and routes/mg.ts; packages/project template consumers; packages/compositions/src/layers/MgLayer.tsx; apps/web template gallery/property consumers.

### KEEP — ships the required fframes and anime template versions

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: ships the required fframes and anime template versions.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — exposes template lookup and a JSON schema for API clients

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: exposes template lookup and a JSON schema for API clients.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — rejects duplicate template versions and invalid defaults

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: rejects duplicate template versions and invalid defaults.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/mg-templates/test/twins.test.ts

Production owner(s), relative to `packages/mg-templates/src/` unless absolute repo path shown: `templates/lower-third.ts, spec.ts`. Non-test callers: apps/engine/src/mg/* and routes/mg.ts; packages/project template consumers; packages/compositions/src/layers/MgLayer.tsx; apps/web template gallery/property consumers.

### KEEP — escapes user-provided text

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: escapes user-provided text.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — converts source-in from flicks to content frames

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: converts source-in from flicks to content frames.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — reuses cache material for equivalent params and changes it for each render input

- B1: docs/specs/11-animation.md ATP-002/003/004/006/009; docs/specs/08-motion-graphics-clips.md; ARCHITECTURE §10.2/D-12; AGENTS security/storage rules. Contract exercised: reuses cache material for equivalent params and changes it for each render input.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from literal formatting/schema/protocol outcomes, independently arranged migration paths and cache changes, or native/TS raster comparison. They can disagree with production.
- B4: public registry/schema/timing/format/render-spec/SVG interfaces; JSON and text are caller-visible formats.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/motion/test/determinism-render.e2e.test.ts

Production owner(s), relative to `packages/motion/src/` unless absolute repo path shown: `runtime/, text/, templates/; packages/compositions/src/SequenceComposition.tsx`. Non-test callers: packages/compositions/src/layers/TextLayer.tsx and MgLayer.tsx; packages/motion/src/templates/* and text/presets.ts.

### KEEP — \`${id}: renderStill per frame = renderFrames c1 = c4 = reversed = shuffled (byte-identical PNGs)\`

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: ${id}: renderStill per frame = renderFrames c1 = c4 = reversed = shuffled (byte-identical PNGs).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — callout paints no premature pulse at clip start

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: callout paints no premature pulse at clip start.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — renderMedia (ProRes 4444) at concurrency 1 and 4 decodes to identical frames

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: renderMedia (ProRes 4444) at concurrency 1 and 4 decodes to identical frames.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — \`${id}: the Player frame matches renderStill (≤ 3/255 on ≥ 99.5 % of the pixels)\`

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: ${id}: the Player frame matches renderStill (≤ 3/255 on ≥ 99.5 % of the pixels).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — \`${id}: a paused Player revisiting frames in any order shows byte-identical pixels\`

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: ${id}: a paused Player revisiting frames in any order shows byte-identical pixels.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — ANM-015: a 200-unit title computes its values in ≤ 2 ms per frame (median, first visits)

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: ANM-015: a 200-unit title computes its values in ≤ 2 ms per frame (median, first visits).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/motion/test/determinism.test.tsx

Production owner(s), relative to `packages/motion/src/` unless absolute repo path shown: `runtime/{timeline,hooks}.ts, text/presets.ts, templates/`. Non-test callers: packages/compositions/src/layers/TextLayer.tsx and MgLayer.tsx; packages/motion/src/templates/* and text/presets.ts.

### KEEP — \`${key} is order-independent, rests outside its window and keeps the build contract\`

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: ${key} is order-independent, rests outside its window and keeps the build contract.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/motion/test/runtime.test.tsx

Production owner(s), relative to `packages/motion/src/` unless absolute repo path shown: `runtime/{timeline,hooks,text,random,eases}.ts`. Non-test callers: packages/compositions/src/layers/TextLayer.tsx and MgLayer.tsx; packages/motion/src/templates/* and text/presets.ts.

### KEEP — pins anime.js 4.5.0 exactly

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: pins anime.js 4.5.0 exactly.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — never autoplays when the caller requests autoplay

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: never autoplays when the caller requests autoplay.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — canonical seek restores the gap value after visiting the end

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: canonical seek restores the gap value after visiting the end.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — frameToMs = frame * 1000 / fps

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: frameToMs = frame * 1000 / fps.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — hash32 is FNV-1a over UTF-8 (parts joined with U+001F)

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: hash32 is FNV-1a over UTF-8 (parts joined with U+001F).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — seededRandom is deterministic per seed and in [0, 1)

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: seededRandom is deterministic per seed and in [0, 1).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — resolves steps and falls back for an unknown ease

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: resolves steps and falls back for an unknown ease.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — returns frozen copies of the seeked values

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: returns frozen copies of the seeked values.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — gives identical values for shuffled frame orders (one mounted instance)

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: gives identical values for shuffled frame orders (one mounted instance).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — builds once ready, seeks per ms before paint and reverts on unmount

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: builds once ready, seeks per ms before paint and reverts on unmount.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — createPausedTimeline drops loop / frameRate / alternate (seek-only driving)

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: createPausedTimeline drops loop / frameRate / alternate (seek-only driving).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — createPausedTimeline drops the unsafe keys from defaults too (children inherit them)

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: createPausedTimeline drops the unsafe keys from defaults too (children inherit them).
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — resolveEase steps: non-finite counts fall back to 8

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: resolveEase steps: non-finite counts fall back to 8.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — useAnimeDom: StrictMode re-mount rebuilds on pristine targets; build-added attributes are removed

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: useAnimeDom: StrictMode re-mount rebuilds on pristine targets; build-added attributes are removed.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — segmentText keeps grapheme clusters: combining marks, ZWJ emoji, flags, CRLF, NBSP

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: segmentText keeps grapheme clusters: combining marks, ZWJ emoji, flags, CRLF, NBSP.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — segmentText words: CJK/Thai dictionary words, emoji-only words, tabs; text always round-trips

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: segmentText words: CJK/Thai dictionary words, emoji-only words, tabs; text always round-trips.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — segmentText without Intl.Segmenter approximates clusters

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: segmentText without Intl.Segmenter approximates clusters.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — needsShaping: RTL (incl. newer RTL scripts and bidi controls), complex scripts and joiners

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: needsShaping: RTL (incl. newer RTL scripts and bidi controls), complex scripts and joiners.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — groupLines measures through offset parents (positioned wrappers) in the container space

- B1: docs/specs/11-animation.md ANM-002/003/004/005/007/010/011/021; ARCHITECTURE §20.2; wp-m2-anime-core hardening regressions. Contract exercised: groupLines measures through offset parents (positioned wrappers) in the container space.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/motion/test/templates-review.test.tsx

Production owner(s), relative to `packages/motion/src/` unless absolute repo path shown: `templates/counter.tsx`. Non-test callers: packages/compositions/src/layers/TextLayer.tsx and MgLayer.tsx; packages/motion/src/templates/* and text/presets.ts.

### KEEP — a large counter advances at frame precision and reaches both endpoints

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: a large counter advances at frame precision and reaches both endpoints.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## packages/motion/test/text.test.ts

Production owner(s), relative to `packages/motion/src/` unless absolute repo path shown: `text/presets.ts`. Non-test callers: packages/compositions/src/layers/TextLayer.tsx and MgLayer.tsx; packages/motion/src/templates/* and text/presets.ts.

### REWRITE — every offered preset resolves and an unknown version does not

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: every offered preset resolves and an unknown version does not.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Rewrite: Drop catalogue implementation inventory; keep unknown-version refusal through public lookup API. Existing per-preset determinism tests own implementations.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

### KEEP — typewriter@2 blinks while idle in either direction and honors caretBlink

- B1: docs/specs/11-animation.md ANM-002…015/021; docs/wp-notes/wp-m2-anime-core.md; docs/wp-notes/wp-m2-text-anim.md typewriter@2; code-audit-audio-animation.md counter regression. Contract exercised: typewriter@2 blinks while idle in either direction and honors caretBlink.
- B2: A caller receives incorrect rendered/temporal/text/registry output for the named input; the corresponding value/state assertion fails.
- B3: Expected results come from fixed timeline endpoints, published UTF-8 FNV vectors, literal Unicode/format examples, immutability/order invariants, or independent still/Player/export pixels. They can disagree with production.
- B4: documented @jasper/motion APIs, actual React hook lifecycle, text animator values, rendered counter text, or real browser/export pixels.
- B5: Keeps the contract across internal renames/reorganization, alternative algorithms and helper call changes; does not pin collaborator calls or source text.
- B6: Lowest stable owner of this distinct parameter, boundary, format or lifecycle case. Broader engine/UI/render smoke coverage does not assert this exact outcome; duplicates listed above are removed.
- Risk: retained requirement or credible regression; no change to expected product behavior. Validation: file command and package typecheck described above.

## Support/seam cleanup completed

- Removed duplicated FFT/pan/biquad helpers/imports and empty describe blocks.
- Removed test-only IIR `design`/`DesignSpec` wrapper, unused elliptic integral `ellipK`, and exported private complex helpers after caller checks; keep real `prototype`/`realize` consumers.
- Removed IR helper exports and unused `ConvolutionReverb.impulse` test hook; make private Phaser sweep and Ambisonics source-gain helpers private.
- Removed production-only-for-tests `kWeightingPower`, `lufsToEnergy`, `blockTruePeak` helpers once their self-oracle/wrapper probes are gone. Independent FFmpeg loudness comparisons remain.
- Retained `ANIMEJS_VERSION`: explicitly documented API/config contract (ARCHITECTURE §20.2, ANM-011), not an expendable test hook.
- Replaced SVG token parser with pixel comparison helper and preserve artifact-producing render tests.

Declaration dispositions: {"DELETE": 37, "REWRITE": 26, "KEEP": 202}.

Before final support edits: `GRAPHIC_EQ_FREQS` / `graphicEqQ` and `tempoDelayMs` have only same-module production callers; remove their now-test-only exports. Retained reverb dry/decay tests will use reported latency.

Additional caller check before support edits: curve helpers are imported directly by production dynamics/mastering modules; the `effects/dynamics.ts` re-export has only test consumers and is not in the package export barrel. Remove that re-export, preserve the actual helpers. `PART` is consumed only within convolution.ts and has no documented API contract; make it module-local.

Final support check before editing: `jumpScore` is only called by `planRemix` in the same module and has no documented API consumer; remove its export. `audio-fx/test/util.ts` exported `run` has no imports (two tests define independent local helpers); delete the orphan wrapper.

## Outcome and validation

All 35 assigned files were audited and the pruning/rewrites implemented: **37 DELETE, 26 REWRITE, 202 KEEP** original test declarations (265 total; parameterized declarations include all generated cases). No whole test file was removed. Rewritten names may differ from the original names recorded above. Source processing arithmetic and persisted behavior are unchanged.

Removed support consists of the production-derived `sineLufs` oracle, unused `run` test wrapper, SVG token parser, obsolete test imports/setup, test-only IIR `design`/`DesignSpec` wrapper and unused `ellipK`; undocumented `kWeightingPower`, `lufsToEnergy`, `blockTruePeak` helpers; unused convolution `impulse` hook; and test-only exports for IR metadata/generation, convolution partition size, graphic-EQ Q/frequencies, tempo delay conversion, remix jump scoring and the dynamics barrel curve re-exports. Phaser sweep and Ambisonics source-gain methods became private. Actual production consumers of the remaining functions are preserved. Caller/documentation searches found no production caller or documented API contract for each removed seam. The documented `ANIMEJS_VERSION` export/configuration test remains.

- `pnpm install --frozen-lockfile --offline`: completed, no dependency changes. Existing warnings: absent built CLI binaries and ignored onnxruntime-node install script.
- Attempted package baseline: `pnpm exec vitest run packages/audio-dsp/test packages/audio-fx/test packages/mg-templates/test packages/motion/test --maxWorkers=1`. It produced only the Vitest start banner during host contention; interrupted without a test verdict after root requested resource coordination. This is **not** a passing validation run.
- Root’s unchanged baseline recorded the restoration 8× realtime timing case at denoise 4791.7 ms versus an adjusted 4537 ms budget, and reverb/pitch at 7083 ms versus 4338 ms. Both tests were already recorded DELETE before their result: no independent exact 8× requirement was found; performance.md only points back to the test’s own budget. An independent reviewer confirmed the circular reference. These deletions do not claim to fix a product regression.
- Root also reported the retained registry finite-output/subnormal-tail case failing after 289620 ms under contention. Its numeric/safety contract remains unchanged. Failure classification and rerun are pending integration; no expected value or timeout was relaxed here.
- Focused tests, package typechecks, full repository gates, FFmpeg oracle validation and native/Remotion rendering have **not** passed in this worktree. Per root’s resource hold they are delegated to the integrated checkout. The rewritten `MG_PARITY=1` raster comparison needs native `jasper-mg` and Chromium; it writes both native and preview PNGs to a logged temporary artifact directory. No rendered artifact was generated during cleanup.

Independent ownership details: direct DSP tests own mathematical transforms and binary formats; the FFmpeg oracle owns BS.1770/K-weighting scenarios removed from loudness.test.ts. Public effect tests own audible parameter laws and curve/audio agreement; registry.test.ts owns partitioning, reset and extreme-input safety across effects, so duplicate per-effect determinism probes are removed. Public motion runtime tests own timeline/Unicode/lifecycle contracts; rendered counter and cross-render-path suites own visible outputs their runtime tests cannot establish. Template schemas/migrations/cache bytes are public compatibility/storage/security contracts and survive separately from pixel parity.

Additional precise retention sources: `AudioProcessor.process` explicitly promises pass-through beyond the configured channel count (`packages/audio-fx/src/core/effect.ts`), so the registry degenerate-block rewrite verifies that output rather than a stale input from a previous call. Static review suggests some channel utility implementations may violate it; integrated validation must fix the owner if confirmed. The ANM-015 200-unit title / 2 ms budget stays because it is independently specified. ANM-011’s anime.js pin stays as a documented configuration/API promise. ANM-010’s line grouping observes semantic line membership under positioned wrappers, not widths/styles/coordinates for appearance. Template version/schema inventories stay only where they enforce persisted template references or the native CLI/HTTP schema protocol, rather than internal implementation inventories.

Static validation: targeted `pnpm exec biome check --write` on the 31 changed TypeScript files completed successfully (18 files formatted/cleaned). `git diff --check` passed. Reviewed source, test and documentation diffs; final package gates remain delegated as recorded above.

Follow-up dead-seam review before removal: `effects/restoration/dehum.ts::stageMagnitude` is explicitly marked “Exposed for tests” and has no production or test caller (`rg stageMagnitude packages apps docs`). Its magnitude import is otherwise unused. Remove both; public DeHummer processed harmonic rejection/response coverage remains in restoration.test.ts.


## Confirmed channel-boundary regression follow-up

Authorized focused validation of the retained/rewritten degenerate-block test failed before any processing change: Dynamics changed the third buffer despite a configured count of two (0.10000000149 → 0.09990477562). Command: `pnpm exec vitest run packages/audio-fx/test/registry.test.ts --maxWorkers=1 -t 'handles empty, single-sample, mono and extra-channel blocks'`; evidence `/tmp/prune2-audio-extra-red.log`, exit 1, 366 ms test time. Independent source is `AudioProcessor.process`'s explicit pass-through promise, not an inferred implementation rule.

Before fixes, extend the same regression case to configured mono/stereo boundaries and default/nondefault parameters so identity defaults cannot hide the violation. Expectations remain literal copies of caller-owned extra input buffers; soft equality assertions collect all violating owners. No private calls, source structure or new implementation-derived oracle is introduced. Real failure modes: writing an unconfigured channel, including it in linked gain detection, or taking a stereo branch for a mono-configured processor. The existing channel API is the lowest stable seam; effect-specific output tests and host tests do not cover incorrect extra-buffer processing.


The expanded pre-fix test failed for 19 effect IDs: ambisonics-panner, amplify, auto-gain, balance, binauralizer, channel-mixer, channel-volume, dynamics, fill-right-with-left, invert, mono-maker, mute, single-band-compressor, stereo-expander, stereo-width, studio-reverb, surround-reverb, swap-channels and tube-compressor (`/tmp/prune2-audio-extra-all-red.log`; 8.15 s test time). ExpanderGate shares the same unbounded detector/output loop and is corrected at that owner too.

The separate product fix limits existing processing/detector loops to the configured count, only takes stereo branches when a second configured channel exists, and passes StudioReverb's configured count into its FDN. No DSP formula, gain curve, valid-channel processing order or timing budget changed. For an ordinary correctly sized input block the processing is identical; additional buffers now remain untouched, as the pre-existing API requires.

Post-fix command: `pnpm exec vitest run packages/audio-fx/test/registry.test.ts --maxWorkers=1 -t 'handles empty, single-sample, mono and extra-channel blocks'` — **PASS**, 1 passed / 4 intentionally unselected, 11.35 s test time (24.52 s total); log `/tmp/prune2-audio-extra-green.log`. Targeted Biome check passed on seven changed TypeScript files. The retained extreme-settings case is running separately; full package/typecheck and integration gates remain pending. Tests ran on the shared 16-CPU host under heavy unrelated load (113.29 load average observed); these durations are validation evidence, not a performance comparison.


Final independent-source correction before the reverb assertion edit: the work note records a credible convolution energy-compensation regression, but the exact `largeHall = 1.9 s` expectation is only present in private IR metadata. That number fails B1/B3 and is removed. The existing REWRITE retains only its separate public wet-output contract: with 100% wet mix an impulse must produce a delayed, nonzero tail, not silence or an unchanged dry impulse. B1: public Convolution Reverb description in `packages/project/src/registry/audio/reverb.ts`; B2: disconnected/blank wet processing fails; B3: a nonzero post-impulse tail is independent of private preset constants; B4: actual `AudioProcessor.process` output; B5: no decay constant, FFT partition or representation is pinned; B6: registry finite/determinism and dry-mix tests cannot detect a silently absent wet path. The Studio Reverb's explicit RT60-parameter test is a different contract; it does not cover the convolution compensation regression. An exact compensation check needs an independently specified impulse/target and is not claimed by this cleanup.
