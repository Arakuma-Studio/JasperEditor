# Resampler coefficient reuse

The browser audio scrubber (`apps/web/src/audio/browser-decode.ts`) calls `resample` for each decoded
clip window; interpreted and reversed media also call it once per mapped file piece. Previously every
call rebuilt the Kaiser coefficient table, even for the same rates and quality. Dense fractional-speed
tables cost more than the convolution of a short window.

`packages/audio-dsp/src/resample.ts` now reuses only coefficient tables, keyed by both rates and quality.
The LRU retains at most eight tables and 16 MiB of coefficients. Larger individual tables are computed
without retaining them. Input/output samples and per-call interpolation state are never cached; the
coefficient calculations and convolution arithmetic are unchanged. There is no API or audio-quality
tradeoff. No external code or formulas were introduced.

## Measurement

```sh
pnpm exec tsx packages/audio-dsp/bench/resample.ts 8b4c8936
```

The benchmark imports the actual old resampler source from git and the working-tree implementation.
It alternates their execution order for 11 rounds on identical stereo inputs, compares every output
byte, and prints every timing. Five paired fresh-module calls additionally measure cold cache misses;
module import time is excluded. This is a resampling microbenchmark, not an end-to-end playback/export
claim. Engine exports use FFmpeg's resampler and are unaffected.

Machine: Linux x64, AMD EPYC-Genoa Processor, 8 logical CPUs, Node 22.23.4, pnpm 10.34.5.
Shared-host load at start/end: 17.57 / 7.80 / 3.09. Timings below are milliseconds, medians.

| Stereo input | Before | Warm after | Speedup | Cold before | Cold after |
|---|---:|---:|---:|---:|---:|
| scrub 44.1→48k fast / 256 samples | 0.5592 | 0.0831 | 6.7× | 9.0751 | 9.1529 |
| scrub 48→44.1k fast / 4096 samples | 4.6765 | 1.9496 | 2.4× | 8.6420 | 6.9311 |
| speed 1.001× fast / 256 samples | 2.8197 | 0.0580 | 48.6× | 9.3159 | 8.9329 |
| dense speed fast / 256 samples | 11.5079 | 0.1524 | 75.5× | 23.6443 | 19.3136 |
| one second 44.1→48k high | 24.3875 | 22.9957 | 1.1× | 34.6739 | 35.7709 |

A preceding paired run at load 10.47 / 4.37 / 1.70 measured 6.1× / 4.9× / 46.1× / 93.7× / 1.01×
for these same five scenarios. An original-versus-original control run before editing measured
0.99–1.04×. The strong, repeatable gain is repeated short-buffer conversion. Long-buffer convolution
still dominates, and cold/miss calls still build the same table. Cold wall times vary with scheduling
and initial JIT work; no cold-call speed improvement is claimed.

Raw warm samples from the table's run, before / after, in milliseconds:

- scrub 44.1→48k fast / 256 samples:
  - Before: 0.6099, 0.5263, 0.5349, 0.5891, 0.5301, 0.5319, 0.5087, 0.5705, 0.5674, 0.5592, 3.5752.
  - After: 0.0976, 0.0983, 0.0828, 0.0828, 0.0819, 0.0778, 0.0831, 0.0871, 0.0800, 0.0968, 0.2739.
- scrub 48→44.1k fast / 4096 samples:
  - Before: 2.8156, 4.6765, 11.2911, 7.7582, 1.6118, 5.4668, 2.5524, 9.1889, 4.2663, 4.6840, 2.9396.
  - After: 1.1894, 3.1368, 0.8469, 0.8307, 0.8476, 2.7345, 1.9496, 1.8599, 2.2721, 4.3369, 5.1593.
- speed 1.001× fast / 256 samples:
  - Before: 2.8197, 2.8593, 2.8053, 2.8222, 2.7840, 3.5934, 2.8958, 2.8106, 2.8091, 3.0525, 2.8145.
  - After: 0.0624, 0.0553, 0.0576, 0.0537, 0.0694, 0.0537, 0.0653, 0.0647, 0.0580, 0.0541, 0.0613.
- dense speed fast / 256 samples:
  - Before: 11.6690, 11.3639, 14.1891, 11.3320, 15.6285, 11.5356, 11.2638, 14.0940, 11.0783, 11.5079, 11.3079.
  - After: 0.1539, 0.1411, 0.1565, 0.1311, 0.2674, 0.2569, 0.1658, 0.1323, 0.1480, 0.1316, 0.1524.
- one second 44.1→48k high:
  - Before: 48.5155, 53.4802, 46.7817, 24.3875, 27.6421, 24.1342, 24.5092, 24.3804, 23.7846, 24.2070, 23.2844.
  - After: 48.3870, 33.1443, 31.5321, 33.8637, 22.9957, 22.1743, 22.4271, 26.3497, 21.5570, 22.5122, 21.6577.

## Validation and limits

- `pnpm exec vitest run packages/audio-dsp/test/resample.test.ts packages/audio-dsp/test/resample-cache.test.ts --maxWorkers=2`: 2 files, 9 tests passed. Existing amplitude/phase, alias/image rejection, impulse alignment, exact/dense-ratio and copy/length checks pass.
- New coverage checks fresh input/channel data on cache hits, quality/rate separation, entry-count eviction, byte-budget eviction, and refusal to retain oversized tables.
- `pnpm --filter @jasper/audio-dsp typecheck`: passed.
- Biome checks on the three changed TypeScript files: passed.
- Benchmark output is byte-identical to the baseline in all five scenarios. The existing rendering algorithms and preview/export routing are unchanged, so no pixel goldens were modified.

The cache retains up to 16 MiB per loaded module instance. Continuously changing speed ratios or more
than eight hot rate/quality combinations can miss or evict; no speedup is promised for those cases.
The independent byte cap prevents a handful of large dense tables from defeating the count bound.
