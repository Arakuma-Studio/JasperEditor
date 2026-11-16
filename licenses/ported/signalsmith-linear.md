# Signalsmith Linear STFT and half-bin real FFT (for the Signalsmith Stretch port)

- **Upstream:** https://github.com/Signalsmith-Audio/linear (tag `0.6.6`, commit `7bb1c8f36794d6980080ce817c91f8da8fe56a66`)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2025 Signalsmith Audio
- **Ported by:** pitch-shifter-formants, 2026-11-16

| Upstream path | Our path | What |
|---|---|---|
| `stft.h` (`DynamicSTFT<…, STFT_SPECTRUM_MODIFIED>`: Kaiser window, `forcePerfectReconstruction`, analysis / synthesis, round-trip window-product normalisation) | `packages/audio-fx/src/effects/pitch/signalsmith.ts` (`Stft`) | The self-normalising STFT the stretcher runs on |
| `fft.h` (`SplitFFT::fastSizeAbove`, `RealFFT<…, halfBinShift = true>`) | `packages/audio-fx/src/effects/pitch/stretch-fft.ts` | FFT sizes 2^k · {1, 3, 5} (one radix-3/5 step over the power-of-two FFT of @jasper/audio-dsp) and the half-bin-shifted real FFT through a half-size complex FFT |

Notes: TypeScript, doubles, no split computation, no SIMD or platform FFT back-ends; only the parts the stretcher uses.
