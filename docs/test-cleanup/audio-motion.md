# Audio, expressions, motion and template follow-up cleanup

Baseline: `8b4c8936`; 73 TypeScript test paths and 564 named declarations. Parameterized declarations stand for all rows/loop variants, not just their first execution. This ledger records the current follow-up; [audio.md](audio.md) and [formats.md](formats.md) contain the earlier source audit of the older files. Historical outcome claims in those reports are not new validation claims.

Every table row uses the six-part evidence immediately above its file: **B1** independent source, **B2** the exact named caller-visible behavior/failure, **B3** independent oracle, **B4** stable seam, **B5** refactor resistance, **B6** unique owner. The case title names its precise scenario/result; configuration, byte and numerical boundaries are intentional contracts, not cosmetic geometry. A property test may assert inside a helper or return a boolean consumed by fast-check; an absence of inline `expect` is not itself a deletion reason.

## Changed decisions and limits

- Engine `audio-classify.test.ts` owns the independently labelled P6-R3 corpus acceptance; three pure generated-material replay tests are removed after cross-owner review. Raw rate/layout/window/error invariants remain in audio-fx, because engine decoding normalizes to16kHz. Shared fixture generators remain live in the engine corpus.
- Remove profile shape/freezing inventories, the copied SplitMix32 mixing oracle, cross-test cue report accumulators and redundant Date/profile executions.
- Preserve documented public exports/configuration (including SplitMix32 and SOLVER_CONSTRAINTS) even where repository callers are absent. Production processing and stored formats remain unchanged.
- Rewrite judge threshold/reason and musical-key expectations so they can disagree with production constants/helpers. Drop incidental solver prose and iteration lower bounds while retaining gains, warning/limit codes, conflict identities and advice data.
- Replace the private 40-variant template builder/target comparison with four caller regressions (one per shipped template) through real public template components. The browser observes a label's actual text range, cumulative opacity and scale/motion, with the independently documented weights/threshold and ±1 frame tolerance. The title uses forward-staggered XY at0.55 and observes the last supplied glyph Y; it must start after the first frame and settle at the cue, catching lost propagation of stagger. The historical cases retain fixed callout land59 and counter exit286 measurements from WP6.5b item16 and emit JSON measurements in `test-results/motion-cues/`.
- All six formerly exported template builder/helpers and four input types are made local after a repository caller search. The pure model's two raw construction/evaluation helpers and three representation types become local too; test-only `target`/`prop` correspondence fields and their unused indexing parameters are removed. They still serve their components; only test-only exports disappear. The two raw model helpers/types had also leaked through facade star exports; no documented or production-consumed facade API is removed.
- Existing Remotion and native parity suites remain opt-in and require their real dependencies. The rewritten default cue tests require Chrome/Playwright and deliberately fail setup if no usable browser exists; they are not moved out of the default gate or replaced with a mock.
- Expensive retained ownership: EBU/FFmpeg oracle programmes distinguish gates, sample rates, layouts and transients; synth hashes/quality cover every promised variant (spec P1-R3); effect extremes/reset/silence protect streaming and silent-strip elision; QuickJS resource/isolation and renderer parity protect failures cheaper seams cannot observe.

## Per-test disposition

### `packages/audio-dsp/test/biquad.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| peaking hits gain at centre | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| low-pass / high-pass are −3 dB at the cut-off | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| notch is deep at centre | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| shelves reach their gain | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| band-pass and all-pass | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| constant-bandwidth cut reaches its depth | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| state flushes to zero (no denormals) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reset clears the memory and setCoeffs keeps it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| matches the BS.1770-4 coefficient table at 48 kHz (1e-6) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/channels.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| layout basics | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| BS.775 downmix coefficients are exact | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| upmix places the source on the front speakers; identity matrices | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| convert applies the matrix per sample | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| applyMatrix: offset/length, gain, accumulate and in-place | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| mono pan is constant power with −3 dB centre | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| stereo balance: unity centre, far side cosine | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pan51MatrixInto writes the same matrix as pan51Matrix into a reused one (the export evaluates per sample) | REWRITE | Replaces600 comparisons to pan51Matrix, which calls the exact same implementation, with independently literal mono front-centre→rear-left gains in one reused NaN-initialized matrix. Public overwrite semantics are documented in channels.ts and required by the per-sample export mixer; catches stale centre/LFE/surround gains when the puck changes. Fresh-allocation panner tests cannot catch reused-buffer leakage. No private layout or helper shape is asserted. |
| point gains are equal power | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| panner matrices | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/ducking.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| envelope levels | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| activity bridges gaps, then drops blips | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sensitivity mapping | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| duck keyframes: basic and merged | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| duck keyframes are clamped to the clip | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| planDucking: trigger activity → keyframes in sequence time | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/fft.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| agrees with the discrete Fourier transform for complex input | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rejects invalid plan size %s before allocating | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rejects mismatched buffers before changing either buffer | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/limiter.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| keeps the output true peak ≤ ceiling + 0.05 dB on adversarial inputs (1.5 ms and 5 ms look-ahead) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| limits steady loud material to the ceiling (not far below) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is transparent below the ceiling, with the reported latency | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| limitBuffer is time aligned, same length, input untouched | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| attack is smooth (no gain step) and release recovers | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| block-size independent and reset restores the initial state | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: random signals never exceed the ceiling + 0.05 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/loudness-oracle-signals.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| sines from 20 Hz to 15 kHz at various levels; different L/R; mono; 32 / 44.1 / 48 / 96 kHz | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 5.1 (L R C LFE Ls Rs, mask 0x3F): LFE excluded, surrounds +1.5 dB, layout agreed with ffmpeg | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| seeded white and pink noise; speech-like programmes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| gated programmes: digital silence and quiet passages exercise both gates | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| loudness-modulated programmes (LRA) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| true peak: inter-sample-peak sines (fs/4 at 45°) and off-grid tones | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/loudness-oracle.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Tech 3341 cases 1, 2: stereo 1 kHz sine at −23 / −33 dBFS → M, S, I = −23.0 / −33.0 LUFS | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Tech 3341 cases 3, 4, 5: gated sequences → −23.0 LUFS | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Tech 3341 case 9 style: S stays −23.0 with 1.34 s @ −20 / 1.66 s @ −30 dBFS alternation | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Tech 3341 cases 10, 12 style: max S of 3 s bursts and max M of 0.4 s bursts at −23 dBFS | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Tech 3342 LRA cases 1–4 (1 kHz stereo) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/loudness.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| silence and below-gate programmes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| custom channel weights can include LFE in loudness | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| truePeak: false measures the same loudness and sample peak, without a true peak | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reset clears everything | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| normalisation helpers | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| missing channels count as silence; measureLoudness summarises | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: results do not depend on how the input is cut into blocks | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/meter.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| linToDb / dbToLin / faderDbToGain | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reports peak, windowed RMS and clipping per channel since the last take | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| RMS is the max of the running window, block-size independent, and drift-free | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| missing channels read silence; reset clears | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| instant attack, linear dB release, peak hold then fall | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/oversample.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| measures inter-sample peaks: fs/4 sine at 45° (44.1/48 kHz), 12 kHz off-grid at 96 kHz (2×) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is at least the sample peak, per channel, and block-size independent | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a burst in the last samples reads the same true peak as one in the middle | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the loudness meter summary of a whole programme includes the tail; streaming reads are unchanged | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| takePeak: per-span peaks (the history kept) whose maximum is the whole stream's true peak | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/resample.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| length = round(len · to / from); equal rates copy | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| high: sine amplitude (< 0.01 dB), frequency and phase preserved up to 0.45·min(fs) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| high: rejects aliasing ≥ 90 dB when downsampling | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| high: rejects imaging ≥ 90 dB when upsampling | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| fast: passband to 0.4·min within 0.01 dB, stop band ≥ 65 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| time alignment of an impulse and arbitrary (dense-table) ratios | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/smooth.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| ramps linearly and lands exactly | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| retarget mid-ramp is continuous | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| zero ramp is immediate | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| withMs, snap and setImmediate | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/sync.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| keeps low frequencies and removes high ones | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| mixdown averages channels | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds pure delays exactly, both signs, and marks them reliable | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| three microphones: mic %i with gain, noise, colouring and fractional delay is within one sample | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| room echo 23 ms later at 0 dB SNR: the direct path wins | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds inverted polarity | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| partial overlap: b covers only the last 4 s of a, and starts before a | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sub-sample delays come out of the parabolic refinement (%s samples) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| unrelated, silent or too-short signals are not trusted | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| maxLag limits the search | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| works at other sample rates (44.1 kHz decimates by 6 to 7.35 kHz) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-dsp/test/wav.test.ts`

- B1: docs/wp-notes/audio-mix.md §§1–3; ARCHITECTURE D-42; licensed RBJ/BS.1770/BS.775/WAVE/GCC-PHAT contracts in licenses/ported/audio-mix.md and multicam.md.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: fixed vectors, physical-unit/analytic signal expectations, independent DFT or FFmpeg, and equal-input streaming/lifecycle invariants.
- B4: public DSP classes/functions and byte formats.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the specific coefficient, channel law, frame/byte boundary, tail/reset state or independent oracle input named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| f32 round trip is bit exact, mono/stereo use plain IEEE float with fact chunk | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 6 channels use WAVE_FORMAT_EXTENSIBLE with the 5.1 mask | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| integer formats round and clip | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| decodes 8/16/24/32-bit PCM, 32/64-bit float, with unknown chunks and pad bytes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| streamed data size and errors | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: encode/decode round trip (f32 exact, integer within half an LSB) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/audio-category.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| music: band, pads, arpeggios, melody, drums, piano (12 s, 44.1 kHz) | DELETE | B1/B6: replayed generated material from the engine labelled corpus with incidental 12 s duration; exact 100% tuning-fixture classification is not the independent P6-R3 acceptance criterion. Engine audio-classify.test.ts retains the independently labelled real/compressed/generated tuning and held-out ≥90% acceptance; raw supported-rate boundaries remain here. |
| ambience: beds, traffic, rain, wind, room tone, AC, forest, office (12 s) | DELETE | B1/B6: duplicates the generated ambience families in engine labelled acceptance. Public pooling, duration, silence, malformed-input and non-16-kHz layout/rate cases survive here, as engine decoding normalizes to16kHz. |
| sfx: every synth recipe (two seeds) and long effects (2–7 s) | DELETE | B1/B6: repeats the same generated recipe/effect families at incidental additional seeds; engine labelled acceptance retains actual compressed inputs and synth families. Synth byte/quality P1-R3 contracts remain in sound-synth.test.ts. Shared category-fixtures.ts remains used by engine acceptance. |
| is deterministic (same features and result twice) | OPTIMIZE | Constructs the identical120BPM/four-bar/seed2 signal directly with the existing testMusic fixture instead of eagerly building13 music families then taking index1; every feature/result assertion and copied-input isolation remains. |
| pools windows of a long clip: four 10 s windows of a 4-minute bed are ambience, durationSec is the clip | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| silence, empty and one-sample inputs are silent (confidence 0) and never throw | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a short click (< 1 s) is sfx; NaN and ±Infinity count as silence | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 8 kHz mono, 96 kHz stereo and 5.1 give the same kind of answer | OPTIMIZE | Constructs the identical90BPM/four-bar/seed1 signal at8kHz directly instead of generating13 music families then taking index0. High-rate ambience, six-channel SFX and all exact classification assertions remain. |
| refuses malformed arguments with AudioCategoryError (E_INVALID_PARAM) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: arbitrary audio never throws; features finite; scores and confidence in 0…1 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| LOW_CATEGORY_CONFIDENCE is the documented 0.6 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/bands.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| is the descriptors’ octaveBandsDb when the window is the whole (fully active) sound | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a full-scale 1 kHz sine reads −3.01 dB in the 1 kHz band and ≥ 40 dB less elsewhere | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| measures only inside the window | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pink noise has equal octave bands within 0.5 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| degenerate input gives the floor and never throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: any samples and window give 7 finite levels ≥ the floor | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sumBandsDb adds energies | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a stereo −20 dBFS 1 kHz sine reads −20 LUFS, like the BS.1770 meter | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds the loudest 400 ms whose centre is in the range, and nothing outside it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| degenerate input gives −Infinity and never throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/beats-tempo.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`a ${bpm} BPM click reads ${bpm} BPM (not half, not double), every beat on its click\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| fast clicks at 44.1 and 48 kHz and other phases read at their own tempo too | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`music: ${name} reads ${bpm} BPM with beats on the drums\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a waltz is detected in 3: one downbeat per bar, on the kick | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 4/4 music and an accented 4/4 click stay in 4; forcing 4 matches auto | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an even click track has no downbeats whatever the metre; invalid metres fall back to auto | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| clicks every 5 BPM from 55 to 205 read at their own tempo | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hostile audio: only NO_BEAT, never a crash; results are well formed | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/beats.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| a click track: tempo within 1 BPM, every beat on its click within 5 ms | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an accented click every 4 beats gives downbeats; an even click track does not | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the generated test music: beats on the drums; deterministic; 48 kHz too | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| refuses audio without a pulse, and too few beats | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/build-sweep.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`a ${hz} Hz sine through ${spec.fromHz} → ${spec.toHz} Hz over ${spec.seconds} s and the release\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/check-curves.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| does not depend on how the stream is cut | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| levels and peaks of a −20 dBFS sine; silence is the floor; non-finite samples count as 0 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the loudest channel's level: a centre-only 5.1 or left-only stereo signal is not lowered by silent channels | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| momentary and short-term curves equal the BS.1770 meter in the steady state | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| maxPool keeps the peaks | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds a reference inside noise at its exact offset, whatever its gain | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the same sound twice in the range: the copy nearer the expected lag; a weak match never wins | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| only looks inside the lag range; null without a fit or energy | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws on hostile input | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| agrees with the solver at the solved gains (lift, peak over bed, true peak, speech lift) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| property: equals the solver at its solved gains for any events (repeats, heroes, speech, silent beds) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| lift follows the gain dB for dB; a silent sound has no lift; never throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/check-findings.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| finds a step in a tone at its sample, as a click; a smooth tone and pink-ish noise have none | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a single-sample spike over quiet noise is a click; a 5 ms noise burst is an attack at most | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is block-size independent and merges channels within 1 ms | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| works at 44.1 kHz and finds nothing under 30 kHz (14 kHz does not fit) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds a click 30 minutes in (streamed, bounded memory) and never throws on hostile input | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| abrupt entry: a sustained source before the In point and no fade; a fade or a silent source clears it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| chopped decay: the clip ends loud while its source goes on; a 30 ms fade or a decayed source clears it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| chopped music: the source sustains past the joint over a quieter entry with a short crossfade | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws and stays finite on hostile input | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 4 kHz tone reads its mean square; 500 Hz and 12 kHz are far down; levels are block-size independent | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is monotone in gain (+g dB in → +g dB out) and harshness compares peaks | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws on hostile input; silence reads the floor | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 1 kHz tone lands in the 1 kHz band; the loudest window is found | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a layer 50 dB under the rest adds ≈ 0 dB; an equal one 3 dB; the target gain makes it add 3 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the addition is monotone in the layer gain and never throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/core.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| delay line reads integer and fractional delays | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| first-order all-pass has unit magnitude | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| PRNG is deterministic and uniform | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |

### `packages/audio-fx/test/delay-modulation.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Delay: echoes at exactly the delay with the feedback series g, g², … and the mix law | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| tempo sync: note values at a tempo | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Multitap: taps at their times and levels | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Analog Delay stays bounded with 200 % feedback and trash | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Flanger: a static delay makes comb notches at odd multiples of 1/(2·delay) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| LFO rate: the chorus/flanger sweep repeats at Speed (±2 %) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| mix 0 is identity for the modulation effects | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |

### `packages/audio-fx/test/design.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Bessel is −3 dB at the cutoff and monotonic | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| high-pass, band-pass and band-stop shapes for every family | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/dynamics.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| steady-state output and transferDb match the textbook curve (peak and RMS detectors) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| attack and release time constants (63 % of the change in dB) are within 15 % of the params | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never exceeds Maximum Amplitude (sample peak), at any boost, in random blocks | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| with True Peak the 4× interpolated true peak stays within ceiling + 0.1 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is a pure delay below the ceiling; latency equals the measured impulse delay | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| brings a loud sine to the ceiling smoothly | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Expander / Gate attenuates by the range below the threshold and holds | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Dynamics rack: compressor section follows its curve; auto makeup; gate closes; soft clip bounded | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Multiband crossovers sum flat (±0.1 dB) when no band compresses | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Multiband compresses only the band over its threshold and meters it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Tube-modeled compressor is near-transparent at low level and compresses loud signals | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/events.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| finds each hit at its attack within 1 ms, in silence and over a bed | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| puts an event's peak where the sound descriptors put it (the point placement aligns) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| names the band the event stands out in | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| measures prominence over the K-weighted bed (and the bed in LUFS) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is block-size independent and finds events across chunk boundaries once | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| times a build-up at its peak | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| finds a digital silence and a drop, with the integrated loudness | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| marks the top 20 % by prominence that are ≥ 6 dB over the bed as accents | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| draws a log-frequency spectrogram, 10 ms × 96 bands | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| integratedOf gates silence and returns null when everything is gated out | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| answers a picture event with the ladder: OK, near, swell, none | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| chance equals a brute-force count of random times | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reports shares with their chance levels and on-beat stats | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws and stays finite | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| handles one sample, DC and long silence | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/filter-eq.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Highpass / Lowpass / Bandpass | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Bass / Treble shelves at 200 Hz and 4 kHz | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Low Shelf / High Shelf | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Simple Parametric EQ and Simple Notch Filter | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| notches are at least 40 dB deep at their centre | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| parameter changes glide (Simple Parametric EQ) and reach the target | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| default parametric is flat | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| parametric bands match the analytic response | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| band types cover peaking, shelves, pass, notch and band-pass (cookbook) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| simple 3-band EQ gains | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| gain change glides without a jump | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a single band at +12 dB peaks at its centre (every band of every size) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| bands hit their gain, measured (premiere_tests) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 24 dB/oct high-pass: −3 dB at the corner, ≈ −48 dB two octaves down (premiere_tests) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pass filters of every slope are digital Butterworths (6·N dB/oct) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| shelves and peaking bands follow the cookbook; bands switch off | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| removes tones and leaves the neighbours | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is a neutral pass-through by default and matches its analytic response | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| matches its design, measured (premiere_tests) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Butterworth: −3.01 dB at the cutoff and a 6·N dB/oct asymptote | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Chebyshev pass-band ripple equals the parameter; elliptic stop band ≥ the attenuation | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| master gain and cutoff glides reach the target design | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| applies its curve (premiere_tests) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| magnitude follows a smooth curve at many frequencies | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| latency() equals the measured impulse delay | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/loop-window.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| avoids spikes and a busy stretch, prefers a long steady window | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 4 s bed is (nearly) its own window | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a level step counts as variance: the steady part wins | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a recording made of spikes still gets the least bad window, marked not clean | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| digital silence is never inside the window; all silence is nothing | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| loop length is a whole number of frames; the rendered loop has no seam | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a drifting recording: the points meet where the levels match better than the window edges | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| mains hum at 25 fps repeats in phase: an equal-gain crossfade keeps the level (measured on the render) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a short window shortens the crossfade to 40 % of it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| quietest stretch outside speech, and the noise floor of the pauses | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| spectral distance: zero for equal shapes, symmetric in level, ignores bands 40 dB down | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws and returns null or finite numbers | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/masking-oracle.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| the lift measured in the mix matches the report within 0.5 dB; caps hold on the audio | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/masking-overlap.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| an ambient effect under a hero is part of its bed: the hero clears bed + ambience by +5 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a partial overlap counts by its share of the window (the masker’s power spread over its own window) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an energy profile counts a decaying masker by the energy it has under the event | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a support masks a hero (not the other way round); peers and the layers of one cue do not mask each other | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| converges in bounded iterations when consistency couples a hero to its masker | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| two heroes that overlap are lowered together until their summed true peak meets the ceiling | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| with peak profiles, overlapping sounds whose peaks do not meet keep (nearly) their own headroom | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a chain: the middle event is in both cliques and takes the larger cut; each clique holds | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a member held by an earlier constraint keeps it; the others absorb the cut | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| with peak profiles: the summed peak holds at every moment (no repeat groups to override it) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the summed true peak of overlapping sounds never exceeds the ceiling (unless a reported conflict says so) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| without repeat groups nothing can override it: the summed true peak always holds | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| converges (bounded iterations), and the reported masking equals a brute-force oracle at the solved gains | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| deterministic, and independent of the input order | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sfxOverlapTerms rebuild the masked bed evaluateSfxGains uses, for any gains and for changed weights (Sound Check joint fixes) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/masking.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| %s reaches +%s dB in its dominant band | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| a second band with ≥ 10 % of the energy is dominant too; the lift is over both | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never goes under the base (default) gain: an unmasked sound keeps it | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| a silent bed (−Infinity bands, no peak) is the floor: base gain, bed cap against the quiet-bed reference | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| a user offset is added; a negative one that leaves the lift short is reported | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a silent sound keeps its base gain and says so | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| empty input | REWRITE | Retains empty gains/events/warnings and converged status at the public solver seam, removing the incidental exact iteration count. A behavior-preserving closed-form or differently initialized solve may report another count. |
| 1 clamp: [−30, +12] | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| 2 bed cap: peak ≤ local bed + 6 LU (support, ambient) / + 10 LU (hero) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 3 hero shadow: a support within 0.15 s of a hero × 0.6; not past 0.15 s, not ambient, not the hero | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 4 consistency: repeats of a sound, then of a type and weight, within the median ± 2 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 5 dialogue guard: during speech, 1–4 kHz lift ≤ +1 dB; advice names types clear of 1–4 kHz | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| dialogue advice names only the dominant bands inside the speech octaves | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| 6 headroom: true peak after the gain ≤ the ceiling (default −1 dBTP); unmeasured → no boost | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| step 4 would break step 2: the bed cap holds and the conflict is reported | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| a step 2 / 3 bound under the gain range: the repeat conflict names that constraint, not the clamp | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| step 4 would break step 3: a shadowed support stays shadowed | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| step 5 and step 6 lose to earlier constraints (spec order), and say so | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the constraints are applied in the spec order | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| caps always hold (or a reported conflict names the constraint that lost); nothing unresolved | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| monotone in the bed: a louder bed never lowers a gain | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a lone event follows the bed dB for dB until a cap, then stays capped | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| deterministic, and independent of the input order | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| NaN / ±Infinity / missing fields are replaced and reported, never propagated | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hostile input never throws and always gives finite gains in range | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| duplicate clip ids: every event is reported, gains keeps the last | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| solves 2000 events in under 50 ms (the bed-alone model of WP4.1a: one pass) | REWRITE | Keeps the independently documented 2000-event/50ms performance budget and all result-count assertions. Drops exact internal iteration count1 and its unused helper result; same behavior/cost with another algorithm must survive. |
| with the masking between overlapping sound effects: 3 passes, ≤ 2.5× one pass, when repeats keep their weight | REWRITE | Keeps the measured2.5× relative cost contract and identical event workload, dropping exact3 iterations. Existing numeric masking/conflict tests own correctness; a cheaper equivalent algorithm should pass. |
| with the masking and one sound repeated across hero, support and ambient: ≤ 4× one pass (13 passes) | REWRITE | Keeps the4× relative cost and public bounded-iteration cap with the same mixed-weight event workload, dropping exact13 iterations that change under equivalent convergence algorithms. |

### `packages/audio-fx/test/music-picture.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| finds the scale of generated music in C major, E♭ major and A minor with a clear confidence | REWRITE | Expected C/Eb/A-minor/G pitch classes are literal music-theory sets rather than keyScale under test. Public analyzeKey on independently generated chords can disagree; no private chroma implementation is asserted. |
| a profile itself is its key; rotating the chroma rotates the tonic (property) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| silence, a steady sine, noise and hostile input: no key or a low confidence, never a throw | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the scales | REWRITE | Uses literal C-major/A-minor/G-major note sets instead of production MAJOR_SCALE or a second keyScale call; public scale API catches wrong interval/rotation logic independently. |
| a generated track with a drop at bar 17 gives it as the top candidate (analyzeBeats and analyzeMusic) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| music without a lift still lists candidates (the loudest bars), deterministically | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| every analysed joint is 3–15 ms before a true attack; remix cuts are at those joints | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| lands the drop earlier, later and in place within 1 ms; joints on bar lines; the outro ends within half a beat | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an exact target no plan reaches is refused with the nearest lengths; fit nearest plans one of them | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| two anchors a whole number of bars apart both land; inconsistent ones are refused | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is deterministic | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hostile anchors and targets are refused with typed errors | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/profile-metrics.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| −20 LUFS pink noise: integrated −20, octave-band shares as pink noise has them | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| identical channels read as a mono mix (−40 dB, correlation 1) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 1 s gap reads 1 s; a 2 s silent start reads 2 s to the first sound | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a hard end against a 2 s fade, and 2 s of dead air | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| clicks at 2/s give 2 onsets/s; each is a salient hit | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 0.5 cut/s picture: 0.5 events/s; sync shares with their chance | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| under 10 s the loudness shape is n.a.; under 3 s or silent nothing is scored | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is independent of the block size | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| truncates at maxSeconds and says so | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hostile input never throws and every metric is finite or null | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/registry.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| refuses unknown processor and parameter identifiers | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| output is independent of the block size, with a parameter change mid-stream | REWRITE | Retains the exact streaming inputs/chunks and1e-6 result tolerance. Rejects nonfinite output on both full-block and fragmented paths; formerly a NaN on the fragmented path made abs(a-NaN)>tolerance false and silently passed. Public block-size invariance is specified by the AudioProcessor streaming contract and not superseded by individual effect tone tests. |
| handles empty, single-sample, mono and extra-channel blocks | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| extreme settings stay finite and tails end without subnormals (%s, %s) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reset restores the initial behaviour | REWRITE | Retains independent before/after reset output invariance on the same seeded input, now checking both stereo channels and rejecting NaN differences. A right-channel-only stale state or NaN previously escaped the left-only negative comparison; public reset semantics require both channels and unique per-processor states. |

### `packages/audio-fx/test/regressions-p0.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| a static parameter applies from the first sample of a new slot | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a keyframed parameter applies from the first sample, and after a reset | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| make-up gain cannot push the output over the limiter threshold | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`passes its pass band: ${sr} Hz ${JSON.stringify(params)} at ${hz} Hz\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sections that come back after an order change start from silence | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Surround Reverb: Dry 0 / Wet 0 silences all six channels; the centre feeds the reverb | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Mastering: output gain and the maximiser apply to every channel | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Loudness Meter measures a 5.1 centre channel | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Loudness Auto Gain weights channels like BS.1770 (LFE ignored, surrounds +1.5 dB) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reach their target after a glide, whatever the control-point phase | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| keeps the wet energy of the impulse at every room size | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a whole note at 30 BPM is 8 s, not cut to 4 s | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/remix.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| finds tempo within 1 BPM and beats within 10 ms (%i BPM at %i Hz) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| silence, a steady tone and noise have no beat | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hits targets within a beat (half a beat at default settings), at beat boundaries, keeping intro and outro | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is deterministic; Segments changes the number of joints; identity at the source length; too-short targets refused | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/restoration.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`notches ${f0} Hz and every enabled harmonic by ≥ 30 dB, keeps a 1 kHz tone within 0.5 dB\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| 60 Hz mode leaves 50 Hz mostly alone; Output Hum Only outputs the removed hum | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| zero reduction is a pure delay of exactly latency() samples | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| \`reduces stationary noise and keeps a tone within 1 dB (${model})\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| learned print gates from the first frame after learning (no adaptation delay) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| cuts a sibilant band by ≥ 6 dB and leaves a 300 Hz tone within 0.5 dB | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| DeReverb at 0 % is a delay; at 100 % it shortens a decaying tail | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Automatic Click Remover removes impulses (≥ 20 dB) and leaves clean audio alone | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Enhance Speech: mix 0 is identity, the EQ shapes a voice band, and noise between words is pushed down | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |

### `packages/audio-fx/test/reverb-pitch.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| 100 % wet produces a delayed reverberant tail | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| mix law: 0 % is the delayed dry signal | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Studio Reverb decays ~60 dB per RT60 and stays bounded | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Surround Reverb: dry 100 / wet 0 is identity; the wet tail exists | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| \`shifts 440 Hz by ${st} st ${cents} cents within 0.5 %\` | OPTIMIZE | The same24000 samples, Hann window and full0.05Hz DFT search grid use independent Goertzel magnitudes with a once-windowed signal, avoiding repeated trig calls; expected frequency/amplitude/rejected-input-tone limits are unchanged. This oracle does not use the production FFT. |
| zero shift is the input delayed by exactly latency() samples | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |

### `packages/audio-fx/test/silence-in-silence-out.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| spec.id | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-descriptors.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| exports a version and the band centres | REWRITE | Retains the independently documented octave-band centre table; removes weak version>=1 assertion duplicated by exact persisted descriptor version2 in sound-quality-flags.test.ts. |
| an impulse at t gives peakSec within 1 ms (and onsetSec just before it) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an impulse at 44.1 and 96 kHz also lands within 1 ms | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| an exponential decay gives decayMs = τ·ln(100)/2 (−20 dB) and its −60 dB tail | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a sine gives its frequency as centroid, rolloff and MIDI pitch | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a sine sits in its own octave band at its mean-square level | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| white noise has flatness ≈ 1 and the shares of a flat spectrum | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pink noise (power ∝ 1/f, 20 Hz … 20 kHz) gives the analytic band shares and equal octave bands | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| brown noise (power ∝ 1/f²) is mostly low | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rise time: a 100 ms linear amplitude ramp rises 10 → 90 % in 80 ms | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| headQuietSec is the head under −40 dB of the sample peak, rounded down | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| counts separate hits, not the tail of one | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| loudness: a stereo 1 kHz sine at −20 dBFS is −20 LUFS, −20 dBTP | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 30 ms click still has a momentary loudness and a true peak | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| stereo width: 0 for dual mono, 0.5 for one side or uncorrelated, 1 for anti-phase | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| dual mono measures like mono (except loudness, which adds the second channel) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| loopable: steady noise and a whole-cycle tone loop; a hit, a fade-in or a click at the wrap do not | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 5.1 sound is analysed (all channels in the envelope and spectrum, L/R for width) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| no channels, empty channels, one sample and silence are defined | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| non-finite samples are treated as silence (sanitised, not propagated) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| channels of different lengths are padded with silence | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| huge finite samples stay finite | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`input longer than ${MAX_ANALYSIS_SECONDS} s reports its real duration and analyses the first ${MAX_ANALYSIS_SECONDS} s\` | OPTIMIZE | Retains real 125 s duration but uses the supported 1 kHz analysis rate instead of 8 kHz. A louder 440 Hz tone only after 120 s must not contaminate the 200 Hz spectrum; this strengthens the previously unproven truncation claim while reducing sample work eightfold. |
| refuses invalid arguments with a typed error | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is deterministic | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws on finite input of any length and channel count; every output is finite and quantised | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws on arbitrary float32 data (NaN, ±Infinity, subnormals, extremes included) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-judge.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| accepts a sound inside every limit with score 1 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| flags %s | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| values exactly on a limit pass | REWRITE | Use literal documented +0.3 dBTP boundary (sound-design wp-note WP1.1b), rather than importing the threshold being tested; detects threshold drift through public judge results. |
| profile switches: no rise limit, no decay needed, no flatness limit, several hits allowed | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| lists every reason in a fixed order and lowers the score with each one | REWRITE | Expected protocol reasons are now literal codes in documented order, independent of JUDGE_REASONS; retains monotonic score checks and catches reordered/missing diagnostics. |
| severity grows with the distance outside the limit | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| never throws on odd profiles: non-finite limits are not checked | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| has a sane profile for every type id (19 effects + ambience + roomtone) | DELETE | B3/B5/B6: self-derived key/field inventories, freezing and generic range checks; explicit type semantics, literal judge vectors, synth acceptance and full project/DSP profile parity survive. |
| types that are one strike are single-hit and must decay; beds are neither | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-oracle.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| needs ffmpeg with aspectralstats and ebur128 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| centroid and rolloff of %s | OPTIMIZE | Flat-band fixture remains an independent sum of the same seeded sinusoids; precomputed second-order oscillators replace repeated sin() calls, without using the production FFT; numerical equivalence is included in pending validation. FFmpeg remains the expected-metric oracle and all tolerance limits remain. |
| integrated loudness, maximum momentary loudness and true peak match ebur128 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-quality-flags.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| is version 2 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| floorDb is the 10th percentile of 20 ms RMS between the events | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| floorDb is null when there is no "between": one event, a sound that fills the file, or under 0.2 s | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| dcDb is the largest channel mean | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| cutoffHz: the cliff of a band limit; none for full-band noise, a natural slope or a tone; null under 44.1 kHz | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rolloff95Hz: full-band noise near the top, an 8 kHz lowpass under it, null under 44.1 kHz | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a clean key passes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| lowpassed: a band-limit cliff under 12 kHz for a type that needs air only (not the 95 % roll-off) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| noisy-floor: a floor between events over −55 dBFS for one-shot types, never for beds or swells | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| dc-offset: a channel mean over −40 dBFS, whatever the type | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the new reasons come last in JUDGE_REASONS and lower the score | REWRITE | Retains literal ordered public judge reason codes and the score decrease; removes the production reason-array slice assertion already protected by public ordered results. |
| version-1 descriptors (without the new fields) judge as before | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a take is judged as one event: singleHit false never reports multi-hit | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| every profile has both new fields | DELETE | B2/B5/B6: field-presence/type checks do not prove audible classification; lowpassed/noisy-floor/DC output vectors and cross-package full profile parity survive. |
| a measured key band-limited at 8 kHz (a low-bitrate encode) is lowpassed; the same key full-band is not | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-review-fixes.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| a sub-normal "signal" reads as silence (null), not −900 LUFS | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| huge finite input is capped | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| missing descriptors or profile are not accepted | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-synth.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| has one recipe for each of the 19 effect types | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| SplitMix32 is the reference sequence | DELETE | B3/B6: reference repeats the production integer mixing steps; every recipe still has an independently pinned public render hash across eight seeds plus variant quality checks. The documented public SplitMix32 export remains. |
| %s renders the pinned bytes, twice the same | CONSOLIDATE | The independent versioned SHA256 oracle over all eight indexed seeds already detects unseeded or changed samples; removes two extra seed3 renders and equality against another call to the same implementation. All original byte hashes remain unmodified. |
| every variant of %s passes the judge as %s | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| variants differ from each other | DELETE | B6: the independently pinned concatenated hash for every recipe already proves the distinct seed0/seed1 bytes; ignoring a seed changes those fixed hashes. Removes38 redundant public renders, preserving all152 quality variants and unsigned-seed refusal boundaries. |
| any 32-bit seed renders; others are refused | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/sound-taxonomy-profiles.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| have the same type ids in the same order | DELETE | B1/B6: relative order of the two independently declared arrays is not a specified interoperability requirement; the surviving full profile-map parity covers missing or extra type keys, while the project taxonomy owns the explicit published vocabulary. |
| have deep-equal profiles for every type, with exactly the same fields | CONSOLIDATE | Survives as one complete public profile-map equality; removes repeated per-key/per-field equality and redundant SOUND_TYPES alias checks. Architecture §3.1 and sound-design §2.1 require model and DSP configuration agreement. |
| are interchangeable types: a project profile can be passed to judgeSound | CONSOLIDATE | Profile compatibility survives in complete map equality; the clean-hit judge result already has the lower owner sound-judge.test.ts / accepts a sound inside every limit. Runtime casts/type aliases do not add behavioral protection. |

### `packages/audio-fx/test/special.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Distortion: hard clip makes odd harmonics only; asymmetry adds even ones; output is DC-free and bounded | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| GuitarSuite with everything off is transparent at low level; defaults produce sound | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Mastering: transparent at its defaults; EQ follows responseDb; the maximizer raises level | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Vocal Enhancer voicings | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Loudness Meter passes audio unchanged and reports the reference sine level | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Mute ramps to silence over 5 ms without a step | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Loudness Auto Gain brings steady signals to the target within 0.5 LU, within the boost/cut limits | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/stereo-channel.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| Amplify reaches exact gains, smoothed, linked or not; −96 dB is silence | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Channel Volume per channel | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Balance and Pan modes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Invert, Swap and Fill route exactly | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Channel Mixer matrix and Stereo Expander mid/side | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| Stereo Width: 0 % is mono, 100 % identity, 200 % doubles the side; mono input stays mono | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| full mode: L = R = (L + R)/2 at 100 %, identity at 0 % | OPTIMIZE | All original samples, comparisons and tolerances remain; aggregate predicates replace per-sample Vitest matcher dispatch (the PRNG preserves the interleaved draw order with streaming first-error indices). NaN/nonfinite differences still fail. This preserves the named public DSP contract and isolation. |
| below mode: the crossover sums flat; lows become mono, highs keep their stereo | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Binauralizer: unity on correlated lows, interaural delay and head shadow | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Ambisonics panner: identity at rest, 180° pan puts the left source on the right | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/audio-fx/test/takes.test.ts`

- B1: docs/wp-notes/audio-fx.md §§1–3 and docs/specs/12-sound-design.md §§2.1–2.4, Phase1 P1-R2/R3 and Phase6 P6-E1/E2/E3/E8/E9/E11/E12; precise per-file requirement references are also in each test header.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: analytic signal/equation vectors, hand-authored descriptors/events, external FFmpeg metrics, musical keys and deterministic/streaming invariants; the rewritten expectations below remove production-derived oracles.
- B4: public createProcessor/AudioProcessor/EffectSlot or exported analysis/solver functions.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the distinct processor configuration, analysis output, constraint interaction, boundary or historical regression named below. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| 10 clicks separated by digital silence give 10 clean takes, each from 5 ms before its attack | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a typing run of down / up pairs gives one joined take per key press | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a pair whose second stroke is louder stays two takes: each peaks on its own stroke | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the same in stereo, and at 44.1 kHz | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a take cut at a boundary is flagged: a file starting inside a sound, one ending inside one, a hit cut by the next | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a hit chopped into digital silence (no decay) is a tail cut | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| keeps at most 64 takes, clean ones first, spread over the whole recording | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is deterministic, and analyzeTakes gives each take its own descriptors with the recording floor | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| empty, one sample, all silence, all NaN, DC | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| refuses invalid arguments like analyzeSound | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| random signals (any length, channels, rate, non-finite samples) give well-formed takes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/bind.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| evaluate() of a bound document returns post-expression values; the raw document is untouched | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a disabled expression renders the keyframed value; status reports errors | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Source Text expressions | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| carry the world, drop Expression Controls and bind after JSON | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| values do not depend on evaluation order (fresh worlds, shuffled frames) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pick-whip references evaluate to the target property | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| selector amounts per unit | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| clip.properties reports the expression, its error and the post-expression value | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/compile.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| rejects deep nesting instead of overflowing | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/ease-assistant.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| drives the original motion path from the slider; outside the span nothing changes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Overshoot passes the final value, then settles on it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Bounce comes back off the final value without passing it, losing height each bounce | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/engine.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| time is sequence seconds, value the keyframed value | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| array maths | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| effect()(…) on this layer and other layers | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| layers: names, indexes (1 = topmost), in/out points, comp attributes | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| text.sourceText and its style | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| transform properties of other layers and toComp/fromComp | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| errors for missing things | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| numKeys, key(n), nearestKey, valueAtTime, velocity | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| loopOut cycle / pingpong / offset / continue | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| posterizeTime, timeToFrames, framesToTime, timeToTimecode | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| markers of the comp and of the layer | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| linear / ease / easeIn / easeOut in both arities | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| vector maths | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| colour conversions | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| random is seeded per layer, property and time; seedRandom and timeless | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| gaussRandom falls mostly in range | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| wiggle: bounded by amp per octave, deterministic, per property | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| noise is smooth and in −1…1 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| no wall clock | CONSOLIDATE | Date determinism has one owner in sandbox.test.ts / the wall clock is unreachable. Its existing public evaluator checks cover direct and prototype clock access; the one unique explicit-year constructor result moves there. |
| syntax and runtime errors carry the line | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| dimension and type errors | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| expressions reading each other: chains work, cycles stop | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| read as AE does | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| renamed instances are found by their name | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a Layer Control expression returns a layer | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| menus take an index or an item name | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/paths.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| points / inTangents / outTangents / isClosed follow After Effects’ vertex model, in the group’s space | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| pointOnPath / tangentOnPath / normalOnPath run along arc length within 0.01 px (rect, ellipse, star, bezier, reversed) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| animated paths evaluate at t (default time); toLayer / fromLayer map the group space to layer pixels | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| bad arguments are expression errors, never crashes; evaluation carries on afterwards | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| bounds the measured size: a path of more than 50 000 segments is refused with an error | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/puppet.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| bound documents and snapshots evaluate the pin expression | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| other properties read pins by name; mesh params refuse expressions | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/sandbox.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| %s does not leak into the next evaluation | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| implicit globals work within an evaluation and vanish with it | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the global object cannot gain properties | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| shadowing layer attributes and writing the evaluation state stay per evaluation | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the wall clock is unreachable (Date through its prototype constructor) | CONSOLIDATE | Surviving owner: public evaluateExpressionText returns fixed zero for direct/prototype wall-clock paths and 2020 for an explicit date; source docs/wp-notes/expressions.md §1.1. This catches host-clock leakage while preserving ordinary Date construction without private realm inspection. |
| overriding inherited methods on own objects still works (no override mistake) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| stops endless loops, recursion and huge strings with messages | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the heap limit: quarantined, the next run is immediate | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the operation budget: quarantined (the clock is frozen, so only the budget can stop it) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the wall clock: quarantined, also when it trips before the heap or the budget would | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| ordinary errors are not quarantined (they are cheap and may depend on the frame) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/shapes.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| drive item properties in documents and render snapshots; content() reaches nested items | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| refuses expressions on gradients and paths | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/three-d.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| a 3D layer at its defaults maps like its 2D Motion; toWorld returns [x, y, z] | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rotated and pushed back: toWorld / fromWorld and toComp / fromComp round trip | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| follows the active camera | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/trim-animate.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`${style}${reverse ? ' reversed' : ''}${animateOffset ? ' + offset' : ''}\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| default eases: progress follows the entering / exiting curves | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`several paths, ${mode}\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| every style pair | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`${o.style}${'reverse' in o ? ' reversed' : ''}: the JSON render snapshot draws what the document draws\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/trim-tracer.test.ts`

- B1: docs/expressions.md; docs/wp-notes/expressions.md §§1.1–1.9; docs/wp-notes/easing.md; docs/wp-notes/shapes.md / Trim Paths animations; AGENTS §0 for bounded parsing and isolation.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal expression results, independent authored paths/intervals, matrix/arc-length formulas, fixed resource refusal categories and pure evaluation invariants.
- B4: public expression evaluator, document/snapshot binding, syntax entry point, and evaluated vector-shape output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named language construct, security/resource isolation path, binding adapter, or rendered trim/tracer geometry; project command tests do not execute QuickJS or evaluate the drawn path. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| End animated on an open path in nested groups (position, rotation, non-uniform scale, anchor) and Motion | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Start animated (erase) on a reversed closed path, with Offset animated: auto picks Start | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Offset wrapping twice around a closed path and across the ends of an open path (End tip) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| Individually: the tip runs over the paths laid end to end; Simultaneously: it follows the chosen path | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| export paths evaluate the same values: the Node snapshot (native sampling) and the JSON snapshot (Remotion) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/anime-contracts.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| exposes anime routing and gallery metadata without marking fframes entries | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/anime-templates.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| rejects unknown fields, invalid RGBA channels and oversized text | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| exposes actual number and colour controls as keyframable | KEEP | ATP-006 exposes counter from/numberColor as continuous properties and decimals/label as non-animatable. Literal public params.* property keys and eligibility values catch broken editing/keyframe metadata at paramsPropertySpecs; rendered default-value tests cannot catch refusal to animate a valid property. |
| anchors the intro at content 0 and the outro at the content end; the hold stretches | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| sourceIn shifts content time; the outro stays anchored at sourceIn + duration | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| converts reference frames to whole frames at other rates (frame-exact) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| compresses intro and outro proportionally when they exceed the content | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| groups thousands, rounds to the decimals, adds prefix and suffix | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| uses a minus sign for negatives and rounds half away from zero without negative zero | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| walks the steps to the newest version, validating and defaulting each result | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| stops at the requested version and refuses unreachable targets | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| prefers a valid direct jump and refuses invalid migration results | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| backtracks from a larger dead-end jump to the highest reachable version | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| tries another path when a direct migration throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/motion-cues.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| v.name | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| a land before the clip’s first frame (sourceIn past the intro) gives no land cue and a null anchor | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the Phase 2 fixture’s lower third (frame 330, 90 frames, 30 fps) lands at 350, not the declared 360 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| prints the measured frames | DELETE | B2/B3/B4/B6: only prints an array and verifies that prior tests appended to it. Each preceding case independently checks land/exit and anchor values; the shared report accumulator is removed. |
| anime templates are measured on their motion model (WP6.5b); a registry without it gets the declared timing | REWRITE | Retains the named numerical outputs, warning/limit codes and independent motion/solver oracle. Removes incidental prose, implementation iteration lower bounds or report-accumulator writes; these must not fail an equivalent refactor. |
| every shipped template is measured: the fframes ones here (VARIANTS), the anime ones in @jasper/motion | DELETE | B2/B5/B6: only inventories function presence, model registration and fixture membership. The existing fframes cue variants assert actual timing/anchors; the four public browser template regressions assert actual rendered motion↔cue agreement. A shape-only registry check adds no independent behavioral protection. |
| a registry without motionSpeed (createStaticMgRegistry) gives the declared frames for the same template | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| clips longer than the measuring cap fall back to the declared timing | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| random templates, clip starts, durations, sourceIn and rates | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| is null for hostile timings and params, never throws | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| the registry memoises per template, params, rate and length and hands out copies | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| a 10-minute lower third: cold derive (measures every frame) and warm derive (memoised) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/parity.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| schemas/ matches the TS catalog (run \`pnpm --filter @jasper/mg-templates schemas\`) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| fframes schemas reject unknown fields and invalid colour or frame values | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`jasper-mg schema\` equals the TS catalog | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| native and TS SVGs paint identical frames | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/registry.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| ships the required fframes and anime template versions | KEEP | ATP-003 and the saved motion-graphic reference protocol require the six literal id@version keys. Public registry lookup/list availability detects orphaned persisted project references; these keys survive internal identifier renames. Timing/render tests do not independently own this complete compatibility vocabulary. |
| exposes template lookup and a JSON schema for API clients | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| rejects duplicate template versions and invalid defaults | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/mg-templates/test/twins.test.ts`

- B1: ARCHITECTURE §§10.2/20.3; docs/specs/11-animation.md ATP-003/004/009 and docs/specs/12-sound-design.md §2.2; sound-design WP2.2a/WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal frame/format vectors, Zod input/output contracts, independent analytic motion rates, cross-renderer painted output and separately shipped JSON/CLI schemas.
- B4: public registry/timing/formatting/render-key functions, SVG output and native CLI schemas/painted output.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named persisted reference, parameter validation, migration graph path, cache-equivalence or cue-alignment boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| escapes user-provided text | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| converts source-in from flicks to content frames | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| reuses cache material for equivalent params and changes it for each render input | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/motion/test/determinism-render.e2e.test.ts`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`${id}: renderStill per frame = renderFrames c1 = c4 = reversed = shuffled (byte-identical PNGs)\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| callout paints no premature pulse at clip start | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| renderMedia (ProRes 4444) at concurrency 1 and 4 decodes to identical frames | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`${id}: the Player frame matches renderStill (≤ 3/255 on ≥ 99.5 % of the pixels)\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| \`${id}: a paused Player revisiting frames in any order shows byte-identical pixels\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| ANM-015: a 200-unit title computes its values in ≤ 2 ms per frame (median, first visits) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/motion/test/determinism.test.tsx`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| \`${key} is order-independent, rests outside its window and keeps the build contract\` | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/motion/test/mg-cue-timing.test.ts`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| covers every shipped anime template, each measured (no declared fallback) | DELETE | B2/B5/B6: table membership/function-shape inventory. Public cue outputs and actual browser motion own historical alignment, and mg-templates owns shipped measured/fallback behavior. |
| \`${v.template} ${JSON.stringify(v.params ?? {})} at ${v.rate} fps, ${v.seconds} s${v.sourceIn ? \`, sourceIn ${v.sourceIn}\` : ''}\` | REWRITE | Private builder target/field comparison fails B4/B5. Survives as the four public rendered label/cue alignment regressions documented above; removes implementation-shaped per-value/every-ease grid while retaining actual threshold agreement for the historical bugs. |
| reports declared (before) vs measured (after) distance to the real frames | DELETE | B3/B4/B6: duplicates previous cases through mutable report state and only prints historical comparisons; the public rendered-motion regressions assert independently sourced frame outcomes. |
| `social-comment cues follow the rendered card` (`%i: %j`, 54 `SOCIAL_ROWS`; merged from feat/social-comments) | REWRITE | The feature's 47 social-comment VARIANTS rows compared private schedule targets with anime.js values (fails B4/B5). Re-expressed in this file's structure: the public `social-comment@1` component rendered in Chrome (`mg-cue-renderer.tsx`: the card box, every word unit, every glyph image and star box, the like count and the drawn star fill to a hundredth), speeds by the documented weights (inner elements by the px they travel), land / exit by the work note's segment rule (sound-design.md "Motion-graphic land / exit from the rendered motion"), cues ±1 frame. Same rows (entrances × extras, every variant, 6 rates, short clips, sourceIn, long marked comment). Found and fixed the model's nominal heart / word sizes and a heart fill store cards do not draw (`SOCIAL_MOTION_METRICS`). |

### `packages/motion/test/runtime.test.tsx`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| pins anime.js 4.5.0 exactly | KEEP | ANM-011 and ARCHITECTURE D-31 explicitly require exact4.5.0 and stamp it into render-cache identity. Literal package dependency key and public ANIMEJS_VERSION can independently disagree after an unsafe upgrade or stale stamp; identifier-only implementation changes preserve them. No broader seek/pixel test enforces this published configuration obligation. |
| never autoplays when the caller requests autoplay | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| canonical seek restores the gap value after visiting the end | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| frameToMs = frame * 1000 / fps | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| hash32 is FNV-1a over UTF-8 and separates seed arguments | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| seededRandom is deterministic per seed and in [0, 1) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| resolves steps and falls back for an unknown ease | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| returns frozen copies of the seeked values | KEEP | ANM API §3 and ARCHITECTURE §20.2 explicitly promise frozen copied targets. Literal500ms/1000ms results prove an earlier caller snapshot cannot change after a later seek, plus public freeze status. This catches aliasing/mutability beyond ordinary current-frame correctness, through the documented hook without private memo/cache inspection. |
| gives identical values for shuffled frame orders (one mounted instance) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| builds once ready, seeks per ms before paint and reverts on unmount | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| createPausedTimeline drops loop / frameRate / alternate (seek-only driving) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| createPausedTimeline drops the unsafe keys from defaults too (children inherit them) | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| resolveEase steps: non-finite counts fall back to 8 | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| useAnimeValues: StrictMode double renders and a buildKey change give the values of a fresh build | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| useAnimeDom: StrictMode re-mount rebuilds on pristine targets; build-added attributes are removed | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| segmentText keeps grapheme clusters: combining marks, ZWJ emoji, flags, CRLF, NBSP | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| segmentText words: CJK/Thai dictionary words, emoji-only words, tabs; text always round-trips | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| segmentText without Intl.Segmenter approximates clusters | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| needsShaping: RTL (incl. newer RTL scripts and bidi controls), complex scripts and joiners | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| groupLines measures through offset parents (positioned wrappers) in the container space | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/motion/test/templates-review.test.tsx`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| a large counter advances at frame precision and reaches both endpoints | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/motion/test/text.test.ts`

- B1: ARCHITECTURE §20.2; docs/specs/11-animation.md ANM-002–015 and ATP-003/004; sound-design WP6.5b item16.
- B2: Each named case below detects failure of its stated observable result for its arranged input, including the specific numerical/error/serialization/lifecycle boundary.
- B3: literal FNV/date/grapheme/rest-state results, independently arranged frame orders and independent browser/render oracles; historic cue pins are read from the work note.
- B4: documented runtime/animator interfaces or public template components; real Chrome measurements replace private template target layouts.
- B5: Observes returned values, persisted/protocol bytes, independently measured audio or rendered behavior; internal helper renames and equivalent algorithms do not change the assertions. Any removed structure/prose assertion is identified below.
- B6: Lowest stable owner of the named seek, text segmentation, hook lifecycle, required compatibility pin or preview/export pixel/motion boundary. Adapter tests remain only for distinct wiring/context/serialization failure modes; broader UI/engine smoke does not assert these exact outcomes.

| Test declaration (all parameterized rows) | Disposition | Reason / surviving protection |
|---|---|---|
| does not substitute a different implementation for an unknown preset version | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |
| typewriter@2 blinks while idle in either direction and honors caretBlink | KEEP | Six-part evidence above; retains the exact named contract and independent output oracle. |

### `packages/expressions/test/fuzz.test.ts` (helper-generated targets)

`describeFuzz` / `textTarget` generates these two runtime cases; the canonical baseline declaration inventory intentionally counts explicit `it` / `test` declarations, so they are additional audited targets rather than duplicate declaration records. Both passed the complete baseline.

- B1: AGENTS §0 requires parser/loader fuzzing; docs/expressions.md and docs/wp-notes/expressions.md specify safe syntax and document-evaluation entry points with returned diagnostics.
- B2: Mutated/truncated/hostile JavaScript must not escape either entry point as an uncaught host exception, and a diagnostic must be a string or null. The evaluation target exercises rotation, position and source-text document bindings.
- B3: The independently specified error-result union and no-host-crash invariant are checked on generated inputs; no production-generated expected expression value is reused.
- B4: Public checkExpressionSyntax and evaluateExpressionText, with a public document/reference/time boundary.
- B5: Internal parser, QuickJS adapter, error wording and binding identifiers can change while returned diagnostics and process safety remain stable.
- B6: Syntax rejection tests use fixed cases and resource tests use selected adversarial programmes; this owner explores combinations of damaged language inputs through actual parsing and binding. The two entry points have distinct crash boundaries. The existing bounded corpus/properties are retained, not replayed in engine/UI tests.

| Generated target | Disposition | Reason / surviving protection |
|---|---|---|
| syntax check (message or null) | KEEP | Six-part evidence above; uniquely catches hostile-input exceptions or invalid result types at the syntax parser boundary. |
| evaluate on a document (value or message) | KEEP | Six-part evidence above; uniquely exercises damaged expressions through the actual QuickJS/document bindings while requiring returned diagnostics. |

## Validation and performance

The coordinator's unmodified Node20.19.0 baseline (`JASPER_REQUIRE_ORACLES=1`, Chrome present, `pnpm test --maxWorkers=2`) contains73 owned files:930 passed cases and8 pre-existing opt-in skips. No owned baseline case failed. The global baseline has2 failures outside this scope (engine cache permission simulation and capture-safe-canvas); their owners investigate them.

The earlier Node24.22.1 experiment failed five pinned synth byte cases. A focused unmodified Node20.19.0 rerun of all19 recipe hash cases passed; no hash was re-blessed. The final validation uses the repository's CI runtime20.19.0. The Jasper Synth section of docs/wp-notes/sound-design.md explicitly limits bit-exactness to a given Node/V8 math implementation and requires a synth version bump when that changes. This is a pre-existing runtime byte-portability limit; cleanup neither changes the version nor re-blesses the independent hashes.

Observed baseline file execution windows (imports/startup excluded; not a scope wall-clock estimate): registry21.681s, synth17.736s, EBU loudness oracle10.730s, music-picture10.336s, reverb/pitch9.200s, tempo7.226s and sync7.170s. Registry extrema/long tails, EBU programmes, explicit152 synth quality variants, raw acoustic sync and genuine musical analysis retain their independently specified contracts. The pitch DFT, duplicate synth renders, generated classifier replay, matcher dispatch and flat-band fixture are the measured optimization targets.

### Completed cleanup and validation

The declaration census is 564 original → 552 current across the same 72 declaration-bearing files; the additional expression fuzz file generates its two cases through testkit. Original dispositions are 497 KEEP, 27 REWRITE, 23 OPTIMIZE, 5 CONSOLIDATE and 12 DELETE. Expanded executions decrease by 51: the original complete baseline had 930 passed and 8 opt-in skipped cases in 73 files; replacing only the 24 changed files' original executions with the validated final executions yields 879 ordinary cases and the same 8 opt-in cases. That is an execution inventory, not a claim to have rerun the 49 unchanged files. The changed test/helper diff is 357 added / 780 removed lines (net −423); internal production export/metadata cleanup is net −35 lines. No fixture, snapshot, dependency or configuration became unused in this scope; generated classifier fixtures remain consumed by the stronger engine corpus owner.

All 24 changed test files passed 458 cases with Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, `JASPER_REQUIRE_ORACLES=1`, `JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome` and two workers. Twelve non-profile files passed 294 cases in 45.54 s runner time. The 12-file profile group passed 164 final cases on each of its two executions. The restored mutation targets then passed 13 selected cases; the other 185 cases in that narrowly filtered rerun were deliberately unselected, having passed their complete changed-file runs already. All five affected package typechecks passed. No owned runtime failure required changing production behavior.

The exact non-profile command was:

```sh
pnpm exec vitest run packages/audio-dsp/test/channels.test.ts packages/audio-fx/test/masking-overlap.test.ts packages/audio-fx/test/masking.test.ts packages/audio-fx/test/music-picture.test.ts packages/audio-fx/test/registry.test.ts packages/audio-fx/test/sound-judge.test.ts packages/audio-fx/test/sound-quality-flags.test.ts packages/audio-fx/test/sound-taxonomy-profiles.test.ts packages/expressions/test/engine.test.ts packages/expressions/test/sandbox.test.ts packages/mg-templates/test/motion-cues.test.ts packages/motion/test/mg-cue-timing.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/jasper-test-cleanup/audio-other.json
```

The four paired profile commands used the following 12 targets with the same environment and worker limit, adding `--reporter=json --outputFile=/tmp/jasper-test-cleanup/audio-{before|after}-{1|2}.json`:

```sh
pnpm exec vitest run packages/audio-fx/test/core.test.ts packages/audio-fx/test/special.test.ts packages/audio-fx/test/filter-eq.test.ts packages/audio-fx/test/delay-modulation.test.ts packages/audio-fx/test/reverb-pitch.test.ts packages/audio-fx/test/restoration.test.ts packages/audio-fx/test/stereo-channel.test.ts packages/audio-fx/test/dynamics.test.ts packages/audio-fx/test/sound-oracle.test.ts packages/audio-fx/test/sound-descriptors.test.ts packages/audio-fx/test/audio-category.test.ts packages/audio-fx/test/sound-synth.test.ts --maxWorkers=2
```

Each typecheck was run as `pnpm --filter @jasper/<name> typecheck` for `audio-dsp`, `audio-fx`, `expressions`, `motion` and `mg-templates`. Biome checked every changed TypeScript file without fixes, and `git diff --check` passed. The coordinator's integrated full gate remains authoritative; optional native/Remotion rendering is not claimed as validated here.

### Measured performance

Measurements used this 8-vCPU AMD EPYC-Genoa Linux host with 15 GiB RAM, no swap, system FFmpeg 6.1.1 and Chrome 156.0.8078.47. Two fresh-process runs of each state were interleaved **before / after / before / after**, using the original `8b4c8936` test contents for the before state and unchanged production processing code. The script restored all final source bytes in a `finally` block. One other scheduled Sound Check validator shared the host; the starting one-minute loads were 3.96, 3.89, 3.87 and 3.71. These are scoped shared-host measurements, not a full-suite or CI improvement claim. The original group had 169 cases, the final group 164; the removed executions failed the behavioral bar or duplicated the engine corpus / versioned hash owner described above.

| Twelve-file group | Before | After | Observed saving |
|---|---:|---:|---:|
| First process wall time |36.024s|24.640s|11.385s|
| Second process wall time |38.773s|22.152s|16.622s|
| Median process wall time |37.399s|23.396s|14.003s (37.44%)|
| Median user + system CPU |80.705s|53.055s|27.650s (34.26%)|

Median summed individual-case durations, excluding import/setup, identify the work removed: synth 18.070→12.005s, reverb/pitch 9.161→1.813s, generated classifier 6.817→1.557s, primitive matcher loops 2.302→0.025s and sound oracle 2.156→0.928s. The synth suite still hashes every channel of all eight seeds for each recipe and judges all 152 variants. The pitch estimator retains the same input, Hann window, frequency grid and 0.5% acceptance through an independent Goertzel recurrence. The flat-band fixture still synthesizes all 751 tones over 48,000 samples; direct-sine versus recurrence comparison measured a maximum sample difference of 1.862645149230957e−9 and RMS 9.054858723952626e−12 after the same Float32 rounding/normalization.

The slowest changed owners after cleanup remain the 124-case effect registry (20.825 s complete-file test duration in the non-profile run), synth (11.855–12.156 s summed case time), and music-picture (10.265 s complete-file test duration). The registry uniquely checks every processor's streaming, finite extremes, denormal tails and reset; reducing its 12-second tail would remove the stated failure window. Synth's full variant promise and musical/drop analysis's independently arranged attack/bar positions justify their remaining data. Startup/import cost remains material; no package runner, mandatory gate or opt-in switch was weakened to hide it.

### Regression-detection checks

Nine temporary production mutants failed their intended assertions, and all original source bytes were restored. Each used `pnpm exec vitest run <owning-file> --maxWorkers=1 -t <named-contract>` with the same required-oracle/browser environment.

| Mutant | Intended failing observation |
|---|---|
| Descriptor analysis cap 120→125 seconds | Loud late tone changes the independently expected 200 Hz centroid; duration remains 125 s. |
| Title component discards supplied stagger | Last glyph starts moving at frame 1, violating forward stagger's later onset; the surviving test observes its rendered text. |
| Fragmented amplifier blocks emit NaN | Streaming owner rejects nonfinite fragmented output. The original test falsely passed this exact mutant. |
| Amplifier reset corrupts only the right gain | Reset owner detects right-channel sample mismatch. The original test falsely passed this exact mutant. |
| PRNG bipolar output becomes NaN | Aggregated range assertion still rejects the first sample. |
| Pitch processor ignores the requested shift | All five independently expected pitch rows fail their 0.5% frequency tolerance. |
| Clipped true-peak boundary 0.3→0.2 dB | Literal 0.3 dB boundary sound is incorrectly rejected. |
| Major scale second degree 2→1 | Independent literal musical interval vector disagrees. |
| Callout render time advances 500 ms | Painted label settling and cue differ by 30 frames. |

After restoration, all 13 selected contract cases passed across seven files. The browser artifacts in `test-results/motion-cues/*.json` contain actual samples and measured speeds: callout last-moving frame 59, counter first exit 286, lower-third last-moving frame 51 and forward-staggered title's last glyph first-moving 23 / last-moving 54. Thus the historical pins and the title onset guard exercise painted behavior through public components, without depending on private target ordering or internal exports. No golden output or synth byte pin was re-blessed.
