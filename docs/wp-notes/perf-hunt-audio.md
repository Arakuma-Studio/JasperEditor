# FFT plan construction

`Fft` is shared by audio synchronization, voice analysis and the spectral audio
effects. Its constructor built the bit-reversal permutation by visiting every
bit of every index. Large synchronization transforms deliberately do not retain
plans above 262,144 points, so this setup repeats for their forward and inverse
transforms. Smaller effect processors also construct their own plans.

The permutation now derives each index from the already reversed index at
`i >>> 1`: shift that reversal right and put the low bit of `i` in the highest
position. This produces the same integers in O(n) work instead of O(n log n).
Twiddle calculations, butterfly operations, validation, allocations and the
existing cache policy are unchanged. No external code or formula was added;
the recurrence follows directly from reversing a fixed-width binary index.
There is no API or audio-quality tradeoff.

## Measurement

```sh
pnpm exec tsx packages/audio-dsp/bench/fft-plan.ts eb28696c
```

The benchmark imports the actual baseline FFT and synchronization source from
git, alternates baseline/current calls on identical inputs, and reports every
timing. Construction includes allocation and twiddle setup. It checks byte
equality of both complex buffers after forward and inverse transforms at 2,048,
262,144 and 1,048,576 points, plus exact equality of the synchronization result.
Ten warm-up rounds precede eleven timed pairs. A baseline-versus-baseline
control was run before the implementation changed: construction at 1,048,576
points measured 22.89 / 23.52 ms and synchronization 261.92 / 272.81 ms.

Machine: Linux x64, AMD EPYC-Genoa Processor, eight logical CPUs, Node 24.22.1,
pnpm 10.34.5. Other agents ran builds and tests on this host. The measured run
below started at load 5.05 / 5.63 / 2.74 and ended at 6.72 / 5.97 / 2.91.
These are medians in milliseconds for these workloads, not whole-editor gains.

| Workload | Baseline | Current | Ratio |
|---|---:|---:|---:|
| Construct 100 plans of 2,048 points | 4.868 | 3.439 | 1.42× |
| Construct one plan of 262,144 points | 7.216 | 4.345 | 1.66× |
| Construct one plan of 1,048,576 points | 24.752 | 10.293 | 2.40× |
| Uncached 1,048,576-point transform, setup included | 115.431 | 97.920 | 1.18× |
| Synchronize a 30-second 8 kHz pair | 241.889 | 203.612 | 1.19× |

Three preceding paired runs measured the 1,048,576-point constructor at
22.950 / 10.052 ms, 25.453 / 10.172 ms and 22.766 / 9.492 ms. Their
synchronization medians were 267.680 / 229.244 ms, 276.400 / 255.406 ms and
234.025 / 210.701 ms. Setup savings repeat; a single complete transform has
substantial host/JIT variation (earlier ratios 1.01× / 1.13× / 1.01×).
No steady-state playback or export speedup is claimed. Reused plans do not
rebuild their permutation; the control below explains a limitation of timing two
separately loaded copies of the same transform in one process.

Raw samples from the table's run, before / after:

- 1,048,576-point construction:
  - Before: 28.315, 23.243, 24.635, 29.960, 31.362, 24.231, 26.957, 23.599, 24.752, 22.576, 29.147.
  - After: 9.927, 10.293, 9.633, 10.324, 16.789, 13.360, 10.171, 10.689, 9.922, 9.694, 17.115.
- Synchronization:
  - Before: 235.242, 245.512, 246.158, 307.293, 238.887, 241.889, 242.874, 228.084, 268.658, 232.639, 220.927.
  - After: 203.105, 209.445, 221.989, 197.090, 198.548, 202.274, 214.962, 203.612, 214.579, 212.764, 203.171.

## Reused-plan control

An integrated rerun of the paired benchmark produced separate timing bands for
the reused 1,048,576-point plan: baseline median 56.086 ms, current 77.469 ms.
The same run retained construction at 20.877 / 8.979 ms and synchronization at
205.073 / 178.110 ms. The reused transform methods were unchanged in source,
had identical runtime `toString()` output and had the same instance field order.

The control `pnpm exec tsx packages/audio-dsp/bench/fft-plan.ts 62249a37` compares
the current implementation with its identical committed source. It reproduced
the reused-plan split, 61.941 / 78.376 ms, while constructor medians were
9.093 / 9.238 ms, uncached transforms 82.318 / 79.636 ms and synchronization
183.059 / 179.004 ms. Thus that paired reused-plan split cannot be attributed to
the permutation change. Its precise JIT/allocation/cache cause was not isolated.
Do not interpret that scenario's ratio as a reused-transform gain or regression.

```sh
pnpm exec tsx packages/audio-dsp/bench/fft-reused.ts eb28696c
```

This additional control loads each source through the same module format and
allocation order in a fresh process. Three processes per version run in
alternating order; each performs 30 warm-ups and 15 timed transforms. It records
wall and CPU time and asserts equal SHA-256 digests of both complete output
buffers. On the same Node 24 host, at start load 7.18 / 4.89 / 3.41 and end load
8.80 / 5.42 / 3.63, per-process wall medians were baseline
78.365 / 82.077 / 87.648 ms and current 75.442 / 81.992 / 81.015 ms. Medians of
those process results were 82.077 / 81.015 ms; CPU medians were 81.450 / 81.032 ms.
An earlier isolated run also measured approximately equal groups,
82.640 / 81.733 ms. These controls support no reused-transform speed claim;
the reproducible improvements are permutation setup and the measured sync calls.

## Validation and limits

- `pnpm exec vitest run packages/audio-dsp/test/fft.test.ts packages/audio-dsp/test/sync.test.ts --maxWorkers=2`:
  two files, 32 tests passed. New independent complex-impulse forward/inverse
  checks include the smallest plan and an uncached 524,288-point plan. Existing
  complex DFT properties and synchronization tests retain their tolerances.
- `pnpm exec vitest run packages/audio-dsp/test/voice.test.ts packages/audio-fx/test/filter-eq.test.ts packages/audio-fx/test/reverb-pitch.test.ts packages/audio-fx/test/remix.test.ts --maxWorkers=2`:
  four files, 59 tests passed, including downstream spectral effect processing.
- `pnpm --filter @jasper/audio-dsp typecheck`: passed.
- Biome checks on the changed TypeScript files: passed.
- The two retained benchmarks additionally passed a direct strict TypeScript
  check, since the package's normal typecheck excludes its `bench` directory.
- All retained paired benchmark output samples and synchronization results
  exactly equal the baseline.
- An additional Node 24 sound-synth control reproduced five pinned-byte failures
  with both the baseline and current FFT, including identical received hashes.
  Recipe generation does not use FFT. The integration run on CI's Node 20.19.6
  passed all 42 synth tests unchanged; no golden or synthesis code was edited.

This removes only permutation setup work. The FFT still allocates the same
buffers, computes the same trigonometric table and runs the same transform.
Long-running processors normally reuse plans, so they receive no per-block
optimization. No document, UI or export-routing behavior changed; no rendering
goldens were updated. Parent integration runs cover the complete repository gate.
