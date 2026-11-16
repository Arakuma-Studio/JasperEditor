# Signalsmith Stretch pitch shifter (the Pitch Shifter's `signalsmith` engine)

- **Upstream:** https://github.com/Signalsmith-Audio/signalsmith-stretch (commit `88061fd4eda56a2353c5d65c74aa3f4ccf76f9da`, version 1.3.2)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.
- **Ported by:** pitch-shifter-formants, 2026-11-16

| Upstream path | Our path | What |
|---|---|---|
| `signalsmith-stretch.h` (`SignalsmithStretch`: presets, `process`, `processSpectrum`, `smoothEnergy`, `findPeaks`, `updateOutputMap`, `estimateFrequency`, `updateFormants`) | `packages/audio-fx/src/effects/pitch/signalsmith.ts` | The phase-vocoder pitch shifter with frequency-map peaks, vertical phase prediction, channel phase locking and formant compensation, ported to TypeScript |

Notes: only pitch shifting with equal input and output lengths is ported, as a streaming in-place processor (one output
sample per input sample, delayed by the block length). Changes for block-size independence and determinism: samples are
processed one at a time on a spectrum grid counted from the reset; the silence bypass counts quiet samples instead of
`process()` calls; the stretch-only time-factor randomisation uses a seeded PRNG; `reset()` also clears the phase
predictions; doubles throughout; no split computation, seek, flush or time stretching. Checked against the C++ upstream
(`SignalsmithStretch<double>`, same input, −1.5 st, formant compensation, tonality limit 8 kHz): max sample difference
1.7e-5 on a 0.43-peak signal (docs/wp-notes/pitch-shifter-engines.md).
